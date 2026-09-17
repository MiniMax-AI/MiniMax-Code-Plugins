import {readableHTML,rawText,escapeHTML} from './readable.mjs';
import {workflowGraph} from './graph-model.mjs';
import {translate,resolveLanguage,readPreference,savePreference,describeFailure,LANGUAGE_KEY} from './i18n.mjs';
const $=s=>document.querySelector(s);
let nodeRaw=false,nodeSignature='',copyValue='',copyTimer;

let scheduler={active:0,limit:8,queued:0};
let showPlan=false,readSignature="",selectionVersion=0;
let runs=[],current=null,selected=null,events=[],after=0,zoom=0,zoomAuto=true,tab='output',busy=false,defaults={maxSteps:120,stepTimeoutMs:1800000,runTimeoutMs:7200000};const ns='http://www.w3.org/2000/svg';
const labels=new Proxy({}, {get:(_,key)=>{const v=t('status.'+key);return v==='status.'+key?key:v}});
const eventLabels=new Proxy({}, {get:(_,key)=>{const v=t('event.'+key);return v==='event.'+key?key:v}});
let preference=readPreference(safeStorage()),language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]),connectionKey='connecting',mcodeAvailable=true,readMode=null,lastAlert='',lastFormMessage=null;
const defaultScripts={en:DEFAULT_ENGLISH_EXAMPLE,zh:''};
const t=(key,vars)=>translate(language,key,vars);
function safeStorage(){try{return localStorage;}catch{return null;}}
function apiMessage(message){return language==='en'&&/[\u4e00-\u9fff]/u.test(message)?(message.includes('访问凭证无效')?t('authError'):t('serviceError')+' '+t('originalReason',{cause:message})):message;}
function error(message,localized=false){lastAlert=message;$('#alert').textContent=localized?message:apiMessage(message);$('#alert').hidden=!message;}
async function api(path,method='GET',data){const r=await fetch(`/api${path}`,{method,headers:{'X-Workflow-Client':'1',...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const value=await r.json();if(!r.ok)throw Error(value.error??`HTTP ${r.status}`);return value;}
function el(tag,attrs={},text){const e=document.createElement(tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
function svg(tag,attrs={},text){const e=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;}
function short(s,n=24){return s.length>n?s.slice(0,n-1)+'…':s;}
function renderList(){const list=$('#run-list');list.replaceChildren();$('#run-count').textContent=runs.length;for(const r of runs){const b=el('button',{title:r.name,class:`run-item ${current?.id===r.id?'active':''}`,'aria-current':current?.id===r.id?'true':'false'});b.append(el('span',{class:`run-dot ${r.status}`}));const title=el('span');title.append(el('b',{},r.name),el('small',{},`${r.executor==='demo'?t('demo'):'MCode'} · ${labels[r.status]??r.status}`));b.append(title);b.onclick=()=>selectRun(r.id).catch(e=>error(e.message));list.append(b);}}
async function refreshList(){[runs,scheduler]=await Promise.all([api('/runs'),api('/scheduler')]);renderScheduler();renderList();if(!current){const id=new URLSearchParams(location.search).get('run')||runs[0]?.id;if(id)await selectRun(id);}}
const viewing=(id,version)=>current?.id===id&&selectionVersion===version;
async function selectRun(id){
 const version=++selectionVersion;
 try{
  const next=await api(`/runs/${id}`);if(version!==selectionVersion)return;
  current=next;history.replaceState(null,'',`${location.pathname}?run=${encodeURIComponent(id)}`);showPlan=false;selected=null;events=[];after=0;zoom=0;zoomAuto=true;error('');renderList();renderRun();await loadEvents(id,version);
 }catch(e){if(version===selectionVersion)throw e;}
}
async function loadEvents(id,version=selectionVersion){
 try{
  const data=await api(`/runs/${id}/wait?after=${after}`);if(!viewing(id,version))return;
  events.push(...data.events.filter(e=>e.seq>after));after=Math.max(after,data.nextSequence);events=events.slice(-500);renderEvents();
 }catch(e){if(viewing(id,version))throw e;}
}
async function refreshCurrent(){
 const id=current?.id,version=selectionVersion;if(!id)return;
 try{const next=await api(`/runs/${id}`);if(viewing(id,version)){current=next;renderRun();}}
 catch(e){if(viewing(id,version))throw e;}
}
function renderRun(){renderBrief();const r=current;$('#repair-run').hidden=!r||!['failed','paused','interrupted','cancelled','completed_with_gaps','succeeded'].includes(r.status);const lineage=$('#repair-lineage');lineage.hidden=!r?.repair;lineage.replaceChildren();if(r?.repair){const link=el('a',{href:'?run='+encodeURIComponent(r.repair.sourceRunId)},t('repairSource'));lineage.append(link,document.createTextNode(' · '+r.repair.reason+' · '+t('repairCandidates',{count:r.repair.reuseStepIds.length})));}const review=r?.status==='pending_review';document.querySelector('main').classList.toggle('is-review',review);$('.metrics').hidden=review;$('.timeline').hidden=review;$('#report').hidden=review;$('#save-template').hidden=!r||review;$('#review-budgets').textContent=r?t('reviewBudgets',{concurrency:r.concurrency,calls:r.maxCalls,steps:r.maxSteps,minutes:r.stepTimeoutMs/60000}):'';$('#review-banner').hidden=!review;$('#edit-draft').hidden=!review;$('#approve').hidden=!review;$('#review-version').textContent=review?`v${r.revision}`:'';$('#graph-mode').hidden=!r?.topology||review;$('#graph-mode').textContent=t(showPlan?'showExecution':'showPlan');$('#topology-note').hidden=!r?.topology;$('#topology-warnings').textContent=r?.topology?.warnings.map(w=>t('topology.'+w)).join(' ')??'';$('#empty').hidden=!!r;$('#run-view').hidden=!r;if(!r){$('#run-title').textContent=t('canvas');$('#executor-badge').textContent=t('noRun');for(const id of ['pause','cancel','resume'])$('#'+id).hidden=true;return;}$('#run-title').textContent=r.name;$('#executor-badge').textContent=r.executor==='demo'?t('demoRun'):t('realRun');$('#metric-status').textContent=labels[r.status]??r.status;$('.status-metric').dataset.status=r.status;const tasks=r.steps.filter(s=>s.kind==='agent');const visibleNodes=graphSteps(),knownNodes=visibleNodes.filter(n=>!n.placeholder||!n.dynamic).length;$('#metric-nodes').textContent=`${tasks.filter(s=>s.status==='succeeded').length} / ${knownNodes}${visibleNodes.some(n=>n.placeholder&&n.dynamic)?'+':''}`;$('#metric-calls').textContent=`${r.attempts} / ${r.maxCalls}`;const usage=tasks.flatMap(s=>[...(s.usageHistory??[]),...(s.usage?[s.usage]:[])]);$('#metric-tokens').textContent=r.executor==='demo'?'—':usage.length?usage.reduce((n,s)=>n+(s.totalTokens??((s.inputTokens??0)+(s.outputTokens??0))),0).toLocaleString(language==='zh'?'zh-CN':'en-US')+(usage.length<r.attempts?t('unknownPlus'):''):t('unknown');$('#pause').hidden=r.status!=='running';$('#cancel').hidden=!['running','queued'].includes(r.status);$('#resume').hidden=!((!r.revision||r.approvedRevision===r.revision)&&['paused','failed','interrupted','cancelled','needs_attention','completed_with_gaps'].includes(r.status));$('#canvas-status').textContent=labels[r.status];$('#canvas-status').dataset.status=r.status;if(r.error){const f=describeFailure(language,r.errorDetails,r.error);error(f.title+(f.original?' '+t('originalReason',{cause:f.original}):'')+(/DEPENDENCY/.test(r.errorDetails?.code??'')?' '+f.advice:''),true);}renderGraph();renderNode();renderRead();}
function graphSteps(){return workflowGraph(current,{planOnly:showPlan}).nodes;}
function renderGraph(){
 const graph=$('#graph'),focused=document.activeElement?.getAttribute('data-step-id');graph.replaceChildren();const steps=graphSteps().filter(s=>s.kind==='agent');$('#graph-wait').hidden=steps.length>0;renderLegend(steps);
 const phases=workflowGraph(current,{planOnly:showPlan}).phases;if(steps.some(s=>!s.phase))phases.push({id:null,label:t('defaultPhase')});
 const positions=new Map(),rows=Math.max(1,...phases.map(p=>steps.filter(s=>s.phase===p.id).length));
 const column=332,cardWidth=264,cardHeight=118,w=Math.max(350,phases.length*column+14),h=Math.max(280,rows*144+110);
 phases.forEach((p,i)=>{const tasks=steps.filter(s=>s.phase===p.id);tasks.forEach((s,j)=>positions.set(s.id,{x:42+i*column,y:86+j*144+(rows>3?0:(rows-tasks.length)*72)}));});
 if(zoomAuto){const wrap=$('#graph-wrap'),wide=window.innerWidth>620;zoom=Math.max(wide?.5:.72,Math.min(1,(wrap.clientWidth-40)/w,wide?(wrap.clientHeight-24)/h:1));}
 $('#zoom-reset').textContent=Math.round(zoom*100)+'%';graph.setAttribute('viewBox',`0 0 ${w} ${h}`);graph.style.width=`${w*zoom}px`;graph.style.height=`${h*zoom}px`;
 phases.forEach((p,i)=>{const x=42+i*column;graph.append(svg('text',{x,y:37,class:'phase-index'},String(i+1).padStart(2,'0')),svg('text',{x:x+25,y:34,class:'phase-label'},p.label),svg('text',{x:x+25,y:51,class:'phase-count'},t(showPlan||steps.some(s=>s.dynamic)?'structures':'tasks',{count:steps.filter(s=>s.phase===p.id).length})),svg('path',{d:`M${x},63 H${x+cardWidth}`,class:'phase-divider'}));});
 for(const s of steps){const to=positions.get(s.id);for(const dep of s.dependsOn??[]){const from=positions.get(dep);if(!from||!to)continue;const x1=from.x+cardWidth,y1=from.y+cardHeight/2,x2=to.x,y2=to.y+cardHeight/2;graph.append(svg('path',{d:`M${x1},${y1} C${x1+42},${y1} ${x2-42},${y2} ${x2},${y2}`,class:`edge ${showPlan||s.placeholder?'planned':''} ${s.status==='running'?'running':''}`}));}}
 for(const s of steps){const p=positions.get(s.id);if(!p)continue;
  const g=svg('g',{class:`node ${s.status} ${selected===s.id?'selected':''}`,transform:`translate(${p.x},${p.y})`,role:'button',tabindex:'0','data-step-id':s.id,'aria-label':`${s.label}，${labels[s.status]??s.status}`,'aria-pressed':String(selected===s.id)});
  const duration=s.startedAt?`${(((s.endedAt??Date.now())-s.startedAt)/1000).toFixed(1)}s`:t('pending');
  g.append(svg('rect',{class:'node-card',width:cardWidth,height:cardHeight,rx:12}),svg('rect',{class:'node-icon-bg',x:15,y:17,width:30,height:30,rx:8}),svg('path',{class:'node-icon',d:'M25 25l-3 7 3 7 M35 25l3 7-3 7 M32 25l-4 14'}),svg('text',{x:54,y:32,class:'node-title'},short(s.label,language==='zh'?12:23)),svg('text',{x:54,y:50,class:'node-kind'},s.placeholder?(s.dynamic?t('dynamicGroup'):s.conditional?t('conditionalNode'):t('plannedNode')):current.executor==='demo'?'DEMO AGENT':'MCODE AGENT'),svg('circle',{class:'node-status-bg',cx:cardWidth-20,cy:25,r:8}),svg('text',{x:cardWidth-20,y:29,class:'node-status-mark','text-anchor':'middle'},s.status==='succeeded'?'✓':s.status==='failed'||s.status==='interrupted'?'!':s.status==='running'?'•':s.status==='queued'?'◷':s.status==='blocked'?'!':s.status==='not_run'?'–':'·'),svg('path',{d:`M0,76 H${cardWidth}`,class:'node-separator'}),svg('text',{x:16,y:101,class:'node-state'},`${s.reusedFrom?t('reusedResult'):labels[s.status]??s.status}${s.attempt>1?t('attemptSuffix',{count:s.attempt}):''}`),svg('text',{x:cardWidth-16,y:101,class:'node-time','text-anchor':'end'},duration));
  if(s.dependsOn?.length)g.append(svg('circle',{class:'port',cx:0,cy:cardHeight/2,r:3}));
  if(steps.some(t=>t.dependsOn?.includes(s.id)))g.append(svg('circle',{class:'port',cx:cardWidth,cy:cardHeight/2,r:3}));
  g.append(svg('title',{},`${s.label}\n${s.id}\n${s.error?describeFailure(language,s.errorDetails,s.error).title:labels[s.status]}`));
  const choose=()=>openNode(s.id);g.addEventListener('click',choose);g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();choose();}});graph.append(g);
 }
 if(focused)graph.querySelector(`[data-step-id="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}
function openNode(id){selected=id;tab='output';nodeRaw=false;nodeSignature='';$('#node-technical').open=false;renderNode();renderGraph();$('#node-scroll').scrollTop=0;}
function renderNode(){
 const nodes=graphSteps(),s=nodes.find(n=>n.id===selected),dialog=$('#node-dialog');
 if(!s){if(dialog.open)dialog.close();return;}
 const index=nodes.indexOf(s);$('#node-position').textContent=`${index+1} / ${nodes.length}`;$('#node-prev').disabled=index===0;$('#node-next').disabled=index===nodes.length-1;
 $('#node-title').textContent=s.label;$('#node-status').textContent=labels[s.status];$('#node-status').dataset.status=s.status;
 $('#node-duration').textContent=s.startedAt?`${((s.endedAt??Date.now())-s.startedAt)/1000}s`:t('notStarted');$('#node-attempt').textContent=s.reusedFrom?t('reusedResult'):s.attempt?`${t('attempt')} ${s.attempt}`:'';
 for(const button of document.querySelectorAll('[data-tab]')){const active=button.dataset.tab===tab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}
 $('#node-content').setAttribute('aria-labelledby','node-tab-'+tab);$('#node-raw').textContent=t(nodeRaw?'viewReading':'viewRaw');$('#node-raw').setAttribute('aria-pressed',String(nodeRaw));
 const q=s.queueInfo;$('#node-queue').hidden=s.placeholder||s.status!=='queued';$('#node-queue').textContent=q?(q.reason==='global_capacity'?t('queueGlobal',{active:q.globalActive,limit:q.globalLimit}):q.reason==='run_capacity'?t('queueRun',{active:q.runActive,limit:q.runLimit}):t('queueDispatch')):'';
 const failure=s.error?describeFailure(language,s.errorDetails,s.error):{title:'',original:'',advice:''};$('#node-failure').hidden=!s.error;$('#failure-title').textContent=failure.title;$('#failure-cause').textContent=failure.original;$('#failure-advice').textContent=failure.advice;$('#failure-code').textContent=s.errorDetails?.code??'';
 const logs=events.filter(e=>e.stepId===(s.actualId??s.id)),value=tab==='output'?(s.error?{error:s.error,details:s.errorDetails}:s.output):tab==='input'?{prompt:s.prompt,input:s.input}:logs;
 const signature=JSON.stringify([selected,tab,nodeRaw,language,s.status,s.placeholder,s.source,value,s.rawOutput]);
 if(signature!==nodeSignature){
  nodeSignature=signature;$('#node-copy-status').textContent='';copyValue=s.placeholder?s.source??'':tab==='input'?`${s.prompt??''}\n\n${rawText(s.input)}`:rawText(tab==='output'&&Object.hasOwn(s,'rawOutput')?s.rawOutput:value);const content=$('#node-content'),scroll=$('#node-scroll').scrollTop;
  if(s.placeholder)content.innerHTML=`<p class="node-empty-reading">${escapeHTML(t(s.status==='blocked'?'blockedHelp':s.status==='not_run'?'notRunHelp':s.dynamic?'dynamicHelp':'awaitingHelp'))}</p><p class="source-note">${escapeHTML(t('sourceLine',{line:s.line}))}</p><pre><code>${escapeHTML(s.source??'')}</code></pre>`;
  else if(nodeRaw)content.innerHTML=`<pre><code>${escapeHTML(copyValue)}</code></pre>`;
  else if(tab==='input')content.innerHTML=`<h3>${escapeHTML(t('nodePrompt'))}</h3>${readableHTML(s.prompt??'',{language})}<h3>${escapeHTML(t('nodeInputData'))}</h3>${readableHTML(s.input,{language})}`;
  else if(tab==='logs'){content.replaceChildren();if(!logs.length)content.append(el('p',{class:'content-empty'},t('noLogs')));for(const e of logs){const item=el('article',{class:'node-log'});item.append(el('strong',{},eventLabels[e.type]??e.type),el('p',{},e.text??e.message??e.error??(e.status?labels[e.status]:'')));content.append(item);}}
  else content.innerHTML=s.error?`<p class="content-empty">${escapeHTML(t('noSuccess'))}</p>${Object.hasOwn(s,'rawOutput')?`<pre><code>${escapeHTML(rawText(s.rawOutput))}</code></pre>`:''}`:s.output==null?`<p class="node-empty-reading">${escapeHTML(t(s.status==='running'?'runningOutput':'noOutput'))}</p>`:readableHTML(s.output,{language});
  $('#node-scroll').scrollTop=scroll;
 }
 const dl=$('#node-meta');dl.replaceChildren();for(const[k,v]of [['ID',s.actualId??s.stepId??s.id],[t('stepLimit'),s.maxSteps??current.maxSteps],[t('nodeTimeout'),t('minutes',{count:(s.timeoutMs??current.stepTimeoutMs)/60000})],[t('session'),s.sessionId??'—']])dl.append(el('dt',{},k),el('dd',{},String(v)));
 if(s.reusedFrom){const link=el('a',{href:'?run='+encodeURIComponent(s.reusedFrom.runId)},s.reusedFrom.stepId);const dd=el('dd');dd.append(link);dl.append(el('dt',{},t('repairSource')),dd);}
 const deps=$('#node-dependencies');deps.replaceChildren(el('p',{},t('dependencies')));if(!s.dependsOn?.length)deps.append(el('span',{},t('none')));for(const id of s.dependsOn??[]){const upstream=nodes.find(n=>n.id===id||n.actualId===id||n.stepId===id);const button=el('button',{type:'button'},upstream?.label??id);button.disabled=!upstream;button.onclick=()=>openNode(upstream.id);deps.append(button);}
 if(!dialog.open)dialog.showModal();
}
function renderEvents(){const list=$('#events'),nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60;list.replaceChildren();$('#event-count').textContent=t('eventsCount',{count:events.length});for(const e of events.slice(-100)){const li=el('li');li.append(el('time',{},new Date(e.time).toLocaleTimeString(language==='zh'?'zh-CN':'en-US',{hour12:false})),el('span',{},`${eventLabels[e.type]??e.type}${e.message||e.text?` · ${short(e.message??e.text,90)}`:e.status?` · ${labels[e.status]??e.status}`:''}`),el('span',{class:'event-node'},e.stepId??e.label??''));list.append(li);}if(nearBottom)list.scrollTop=list.scrollHeight;renderNode();}
function showCreate(){const f=$('#create-form');f.reset();delete f.dataset.repairId;delete f.dataset.sourceUpdatedAt;$('#repair-context').hidden=true;f.elements.repairReason.required=false;f.elements.maxSteps.value=defaults.maxSteps;f.elements.stepTimeoutMinutes.value=defaults.stepTimeoutMs/60000;f.elements.runTimeoutMinutes.value=defaults.runTimeoutMs/60000;delete f.dataset.runId;delete f.dataset.revision;f.elements.name.value=t('defaultName');setMetadataForm({objective:t('defaultObjective'),inputDescription:t('defaultInputDescription'),deliverables:t('defaultDeliverables').split('\n')});delete f.elements.name.dataset.edited;$('#script-input').value=defaultScripts[language];delete $('#script-input').dataset.edited;$('#create-title').textContent=t('newHeading');$('#save-draft').textContent=t('createDraft');$('#form-error').hidden=true;lastFormMessage=null;updateLimitSummary();renderModeNote();$('#create-dialog').showModal();}
function editRun(repair=false){if(!current)return;const f=$('#create-form');delete f.dataset.repairId;delete f.dataset.sourceUpdatedAt;$('#repair-context').hidden=!repair;f.elements.repairReason.required=repair;f.dataset.runId=current.id;f.dataset.revision=current.revision;for(const name of ['name','executor','concurrency','maxCalls','maxSteps'])f.elements[name].value=current[name];f.elements.name.dataset.edited='true';f.elements.stepTimeoutMinutes.value=current.stepTimeoutMs/60000;f.elements.runTimeoutMinutes.value=current.runTimeoutMs/60000;f.elements.inputJSON.value=JSON.stringify(current.input,null,2);setMetadataForm(current.metadata);$('#script-input').value=current.script;$('#script-input').dataset.edited='true';$('#script-editor').open=true;$('#create-title').textContent=t('editDraft');$('#save-draft').textContent=t('saveDraft');$('#form-error').hidden=true;lastFormMessage=null;updateLimitSummary();renderModeNote();$('#create-dialog').showModal();}
$('#edit-draft').onclick=()=>{editRun();if(current?.repair){$('#repair-context').hidden=false;const f=$('#create-form');f.elements.repairReason.required=true;f.elements.repairReason.value=current.repair.reason;$('#repair-diagnostic').textContent=[current.repair.sourceError,...current.repair.failures.map(s=>s.id+': '+(s.error??s.status))].filter(Boolean).join('\n')||t('repairNoError');const list=$('#repair-candidates');list.replaceChildren();for(const id of current.repair.candidateStepIds??current.repair.reuseStepIds){const label=el('label',{class:'repair-candidate'}),checkbox=el('input',{type:'checkbox',name:'reuseStepId',value:id});checkbox.checked=current.repair.reuseStepIds.includes(id);label.append(checkbox,el('span',{},id));list.append(label);}}};
$('#repair-run').onclick=()=>{editRun(true);const f=$('#create-form');delete f.dataset.runId;delete f.dataset.revision;f.dataset.repairId=current.id;f.dataset.sourceUpdatedAt=current.updatedAt;f.elements.repairReason.value='';$('#create-title').textContent=t('repairRun');$('#save-draft').textContent=t('createRepair');$('#repair-diagnostic').textContent=[current.error,...current.steps.filter(s=>s.error).map(s=>s.id+': '+s.error)].filter(Boolean).join('\n')||t('repairNoError');const list=$('#repair-candidates');list.replaceChildren();for(const step of current.steps.filter(s=>s.kind==='agent'&&s.status==='succeeded'&&Array.isArray(s.dependsOn))){const label=el('label',{class:'repair-candidate'}),checkbox=el('input',{type:'checkbox',name:'reuseStepId',value:step.id});label.append(checkbox,el('span',{},step.label+' · '+step.id));list.append(label);}if(!list.childElementCount)list.append(el('p',{class:'subtle'},t('repairNoCandidates')));};
$('#approve').onclick=async()=>{if(!current||busy)return;const id=current.id,revision=current.revision;busy=true;$('#approve').disabled=true;try{await api(`/runs/${id}/approve`,'POST',{revision});await selectRun(id);await refreshList();}catch(e){error(e.message);}finally{busy=false;$('#approve').disabled=false;}};
$('#graph-mode').onclick=()=>{showPlan=!showPlan;selected=null;zoomAuto=true;renderRun();};
$('#new-run').onclick=showCreate;$('#empty-start').onclick=showCreate;$('#close-create').onclick=()=>$('#create-dialog').close();$('#close-read').onclick=()=>$('#read-dialog').close();
$('#create-form [name=executor]').onchange=renderModeNote;
function renderModeNote(){$('#mode-note').textContent=t($('#create-form').elements.executor.value==='demo'?'demoNote':'mcodeNote');}
$('#create-form').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const submit=e.submitter??$('#save-draft');submit.disabled=true;try{const input=JSON.parse(f.get('inputJSON'));if(!input||Array.isArray(input)||typeof input!=='object')throw Error(t('inputObject'));const form=e.currentTarget;const r=await api(form.dataset.repairId?`/runs/${form.dataset.repairId}/repair`:form.dataset.runId?`/runs/${form.dataset.runId}/edit`:'/runs','POST',{requestId:crypto.randomUUID(),...(form.dataset.repairId?{sourceUpdatedAt:Number(form.dataset.sourceUpdatedAt),reason:f.get('repairReason'),reuseStepIds:f.getAll('reuseStepId')}:{}),...(form.dataset.runId?{revision:Number(form.dataset.revision),...(!$('#repair-context').hidden?{reason:f.get('repairReason'),reuseStepIds:f.getAll('reuseStepId')}:{})}:{}),name:f.get('name'),executor:f.get('executor'),concurrency:Number(f.get('concurrency')),maxCalls:Number(f.get('maxCalls')),...readLimits(f),script:f.get('script'),input,metadata:{objective:f.get('objective'),inputDescription:f.get('inputDescription'),deliverables:String(f.get('deliverables')).split('\n').map(x=>x.trim()).filter(Boolean)}});$('#create-dialog').close();await refreshList();await selectRun(r.id);}catch(e){$('#form-error').hidden=false;$('#form-error').textContent=apiMessage(e.message);lastFormMessage={error:e.message};}finally{submit.disabled=false;}};
$('#validate').onclick=async()=>{try{await api('/validate','POST',{script:$('#script-input').value});$('#form-error').hidden=false;$('#form-error').textContent=t('valid');lastFormMessage={key:'valid'};}catch(e){$('#form-error').hidden=false;$('#form-error').textContent=apiMessage(e.message);lastFormMessage={error:e.message};}};
for(const action of ['pause','cancel'])$('#'+action).onclick=async()=>{
 if(!current||busy)return;const id=current.id,version=selectionVersion;busy=true;
 try{const next=await api(`/runs/${id}/${action}`,'POST',{});if(viewing(id,version)){current=next;error('');renderRun();}await refreshList();}
 catch(e){if(viewing(id,version))error(e.message);}finally{busy=false;}
};
for(const b of document.querySelectorAll('[data-tab]')){b.onclick=()=>{tab=b.dataset.tab;renderNode();$('#node-scroll').scrollTop=0;};b.onkeydown=e=>{const tabs=[...document.querySelectorAll('[data-tab]')];let index=tabs.indexOf(b);if(e.key==='ArrowRight')index=(index+1)%tabs.length;else if(e.key==='ArrowLeft')index=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')index=0;else if(e.key==='End')index=tabs.length-1;else return;e.preventDefault();tabs[index].click();tabs[index].focus();};}
$('#node-raw').onclick=()=>{nodeRaw=!nodeRaw;renderNode();};
$('#node-copy').onclick=async()=>{const signature=nodeSignature;try{await navigator.clipboard.writeText(copyValue);if(signature===nodeSignature)$('#node-copy-status').textContent=t('copied');}catch{if(signature===nodeSignature)$('#node-copy-status').textContent=t('copyFailed');}clearTimeout(copyTimer);copyTimer=setTimeout(()=>$('#node-copy-status').textContent='',2500);};
for(const [id,offset] of [['node-prev',-1],['node-next',1]])$('#'+id).onclick=()=>{const nodes=graphSteps(),index=nodes.findIndex(s=>s.id===selected);if(nodes[index+offset])openNode(nodes[index+offset].id);};

for(const [id,fn] of [['zoom-out',()=>zoom=Math.max(.5,zoom-.15)],['zoom-in',()=>zoom=Math.min(2,zoom+.15)],['zoom-reset',()=>zoom=0]])$('#'+id).onclick=()=>{zoomAuto=id==='zoom-reset';fn();$('#zoom-reset').textContent=Math.round(zoom*100)+'%';renderGraph();};
async function renderRead(){
 if(!current||!readMode)return;
 const signature=[current.id,current.updatedAt,current.status,readMode,language,...current.steps.map(s=>s.status)].join('|');
 if(signature===readSignature)return;readSignature=signature;
 const report=readMode==='report',ready=exportable(current);$('#read-dialog').classList.toggle('report-dialog',report);
 $('#read-title').textContent=t(report?'report':'frozenScript');$('#read-content').hidden=report;$('#report-preview').hidden=!report;$('#report-downloads').hidden=!report||!ready;
 if(!report){$('#read-content').textContent=current.script;return;}
 const preview=$('#report-preview');preview.replaceChildren(el('p',{},t(ready?'reportLoading':'exportUnavailable')));if(!ready)return;
 try{const response=await fetch(`/api/runs/${current.id}/report?format=html&language=${language}`,{headers:{'X-Workflow-Client':'1'}});if(!response.ok)throw Error(`HTTP ${response.status}`);const html=await response.text();if(signature!==readSignature)return;const frame=el('iframe',{title:t('report'),sandbox:'allow-popups allow-popups-to-escape-sandbox'});frame.srcdoc=html;preview.replaceChildren(frame);}catch(e){if(signature===readSignature){preview.replaceChildren(el('p',{},t('reportLoadFailed')+' '+e.message));readSignature='';}}
}
for(const mode of ['report','script'])$('#'+mode).onclick=()=>{if(!current)return;readMode=mode;renderRead();$('#read-dialog').showModal();};
async function loop(){for(;;){try{
 if(current&&['running','pausing','stopping','queued'].includes(current.status)){
  const id=current.id,version=selectionVersion;await loadEvents(id,version);if(viewing(id,version))await refreshCurrent();await refreshList();
 }else{await new Promise(r=>setTimeout(r,4000));await refreshList();await refreshCurrent();}
 setConnection('connected');
 }catch(e){setConnection('disconnected');error(e.message);await new Promise(r=>setTimeout(r,4000));}}}
applyLanguage();
try{const c=await api('/config');mcodeAvailable=c.mcodeAvailable!==false;$('#workspace').textContent=c.workspace;defaultScripts.zh=c.example;if(!$('#script-input').dataset.edited)$('#script-input').value=defaultScripts[language];defaults=c.defaults??defaults;const f=$('#create-form');f.elements.maxSteps.value=defaults.maxSteps;f.elements.stepTimeoutMinutes.value=defaults.stepTimeoutMs/60000;f.elements.runTimeoutMinutes.value=defaults.runTimeoutMs/60000;updateLimitSummary();if(c.mcodeAvailable===false){const option=f.querySelector('option[value=mcode]');option.disabled=false;option.textContent=t('missingOption');}setConnection('connected');await refreshList();void loop();}catch(e){setConnection('notConnected');error(e.message);}

new ResizeObserver(()=>{if(current&&zoomAuto)renderGraph();}).observe($('#graph-wrap'));

function closeInspector(){const id=selected;selected=null;renderNode();renderGraph();$('#graph').querySelector(`[data-step-id="${CSS.escape(id??'')}"]`)?.focus({preventScroll:true});}
$('#brief-template').onclick=()=>$('#save-template').click();$('#brief-cancel').onclick=()=>$('#cancel').click();
$('#close-inspector').onclick=closeInspector;$('#node-dialog').addEventListener('cancel',e=>{e.preventDefault();closeInspector();});$('#node-dialog').addEventListener('click',e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeInspector();});

$('#zoom-fit').onclick=()=>{const box=$('#graph').viewBox.baseVal;zoomAuto=false;zoom=Math.min(1.12,($('#graph-wrap').clientWidth-40)/box.width,($('#graph-wrap').clientHeight-20)/box.height);renderGraph();};

function readLimits(f){return {maxSteps:Number(f.get('maxSteps')),stepTimeoutMs:Number(f.get('stepTimeoutMinutes'))*60000,runTimeoutMs:Number(f.get('runTimeoutMinutes'))*60000};}
function updateLimitSummary(){const f=$('#create-form');$('.execution-settings summary').textContent=t('limits',{steps:f.elements.maxSteps.value,minutes:f.elements.stepTimeoutMinutes.value});}
for(const name of ['maxSteps','stepTimeoutMinutes'])$('#create-form').elements[name].addEventListener('input',updateLimitSummary);
$('#close-resume').onclick=()=>$('#resume-dialog').close();
$('#resume').onclick=()=>{if(!current||busy)return;const f=$('#resume-form'),limits=current.legacyLimits?defaults:current;f.dataset.runId=current.id;f.elements.maxSteps.value=limits.maxSteps??defaults.maxSteps;f.elements.stepTimeoutMinutes.value=(limits.stepTimeoutMs??defaults.stepTimeoutMs)/60000;f.elements.runTimeoutMinutes.value=(limits.runTimeoutMs??defaults.runTimeoutMs)/60000;f.elements.maxCalls.value=current.maxCalls;$('#resume-note').textContent=t('resumeNote',{used:current.attempts,max:current.maxCalls})+(current.legacyLimits?' '+t('legacyNote'):'');$('#resume-error').hidden=true;$('#resume-dialog').showModal();};
$('#resume-form').onsubmit=async e=>{e.preventDefault();if(busy)return;const id=e.currentTarget.dataset.runId;let confirmStopped=false;if(current?.id===id&&current.status==='needs_attention'){confirmStopped=confirm(t('confirmStopped'));if(!confirmStopped)return;}const f=new FormData(e.currentTarget),button=e.submitter;busy=true;button.disabled=true;try{await api(`/runs/${id}/resume`,'POST',{...readLimits(f),maxCalls:Number(f.get('maxCalls')),confirmStopped});$('#resume-dialog').close();await selectRun(id);await refreshList();}catch(e){$('#resume-error').hidden=false;$('#resume-error').textContent=apiMessage(e.message);}finally{busy=false;button.disabled=false;}};

function setConnection(key){connectionKey=key;$('#connection').textContent=t(key);$('.connection-dot').dataset.connected=String(key==='connected');}
function applyLanguage(){
 document.documentElement.lang=language==='zh'?'zh-CN':'en';
 for(const e of document.querySelectorAll('[data-i18n]'))e.textContent=t(e.dataset.i18n);
 for(const [attr,key] of [['aria-label','i18nAria'],['title','i18nTitle']])for(const e of document.querySelectorAll('[data-'+(key==='i18nAria'?'i18n-aria':'i18n-title')+']'))e.setAttribute(attr,t(e.dataset[key]));
 $('#language-select').value=preference;
 const script=$('#script-input');if(!script.dataset.edited&&defaultScripts[language])script.value=defaultScripts[language];
 const name=$('#create-form').elements.name;
 if(!name.dataset.edited)name.value=t('defaultName');
 const option=$('#create-form option[value=mcode]');option.disabled=false;option.textContent=t(mcodeAvailable?'mcodeOption':'missingOption');
 if($('#create-dialog').open){$('#create-title').textContent=t($('#create-form').dataset.repairId?'repairRun':$('#create-form').dataset.runId?'editDraft':'newHeading');$('#save-draft').textContent=t($('#create-form').dataset.repairId?'createRepair':$('#create-form').dataset.runId?'saveDraft':'createDraft');}setConnection(connectionKey);renderScheduler();renderModeNote();updateLimitSummary();renderList();renderRun();renderEvents();renderRead();
 if(!current)error(lastAlert);
 if(lastFormMessage)$('#form-error').textContent=lastFormMessage.key?t(lastFormMessage.key):apiMessage(lastFormMessage.error);
 if($('#resume-dialog').open&&current)$('#resume-note').textContent=t('resumeNote',{used:current.attempts,max:current.maxCalls})+(current.legacyLimits?' '+t('legacyNote'):'');
}
$('#script-input').addEventListener('input',e=>e.target.dataset.edited='true');
$('#create-form').elements.name.addEventListener('input',e=>e.target.dataset.edited='true');
$('#language-select').addEventListener('change',e=>{preference=e.target.value;savePreference(safeStorage(),preference);language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]);applyLanguage();});
window.addEventListener('languagechange',()=>{if(preference==='auto'){language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]);applyLanguage();}});
window.addEventListener('storage',e=>{if(e.key===LANGUAGE_KEY||e.key===null){preference=readPreference(safeStorage());language=resolveLanguage(preference,navigator.languages?.length?navigator.languages:[navigator.language]);applyLanguage();}});

function renderScheduler(){$('#scheduler-settings').textContent=t('schedulerBadge',{active:scheduler.active,limit:scheduler.limit});$('#scheduler-usage').textContent=t('schedulerUsage',{active:scheduler.active,limit:scheduler.limit,queued:scheduler.queued});}
$('#scheduler-settings').onclick=async()=>{try{scheduler=await api('/scheduler');renderScheduler();$('#scheduler-form').elements.globalConcurrency.value=scheduler.limit;$('#scheduler-error').hidden=true;$('#scheduler-dialog').showModal();}catch(e){error(e.message);}};
$('#close-scheduler').onclick=()=>$('#scheduler-dialog').close();
$('#scheduler-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{scheduler=await api('/scheduler','POST',{globalConcurrency:Number(e.currentTarget.elements.globalConcurrency.value)});renderScheduler();$('#scheduler-dialog').close();await refreshList();}catch(e){$('#scheduler-error').hidden=false;$('#scheduler-error').textContent=apiMessage(e.message);}finally{button.disabled=false;}};

function setMetadataForm(metadata={}){const f=$('#create-form');f.elements.objective.value=metadata?.objective??'';f.elements.inputDescription.value=metadata?.inputDescription??'';f.elements.deliverables.value=metadata?.deliverables?.join('\n')??'';}
function renderBrief(){
 $('#save-template').hidden=!current||current.status==='pending_review';
 $('#workflow-brief').hidden=!current;$('#brief-objective').hidden=!current?.metadata?.objective;$('#brief-objective').textContent=current?.metadata?.objective??'';$('.review-secondary').hidden=current?.status!=='pending_review';const box=$('#definition-summary');box.replaceChildren();const m=current?.metadata;
 box.hidden=!m||!(m.objective||m.inputDescription||m.deliverables?.length);
 if(m)for(const [key,value]of [['inputDescription',m.inputDescription],['deliverables',m.deliverables?.join(' · ')]])if(value){const item=el('div');item.append(el('b',{},t(key)),el('p',{},value));box.append(item);}
 const latest=current?.latestProgress;$('#latest-progress').hidden=!latest;$('#latest-progress-text').textContent=latest?.message??'';
}
function exportable(run){return ['succeeded','completed_with_gaps','failed','cancelled','paused','interrupted','needs_attention'].includes(run.status);}
for(const button of document.querySelectorAll('[data-report-format]'))button.onclick=async()=>{
 if(!current||!exportable(current))return;button.disabled=true;
 try{const format=button.dataset.reportFormat,id=current.id;const r=await fetch(`/api/runs/${id}/report?format=${format}&language=${language}`,{headers:{'X-Workflow-Client':'1'}});if(!r.ok)throw Error((await r.json()).error);const url=URL.createObjectURL(await r.blob()),a=el('a',{href:url,download:r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]??`workflow-${id}.${format}`});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){error(e.message);}finally{button.disabled=false;}
};
async function renderTemplates(){
 const list=$('#template-list');list.replaceChildren();const templates=await api('/templates');
 if(!templates.length)list.append(el('p',{class:'subtle'},t('emptyTemplates')));
 for(const template of templates){const row=el('article',{class:'template-card'}),text=el('div');text.append(el('h3',{},template.name),el('p',{},template.objective));const use=el('button',{type:'button'},t('useTemplate')),remove=el('button',{type:'button',class:'danger'},t('deleteTemplate'));
  use.onclick=async()=>{use.disabled=true;try{const {definition}=await api(`/templates/${template.id}`);$('#templates-dialog').close();showCreate();const f=$('#create-form');for(const key of ['name','executor','concurrency','maxCalls','maxSteps'])f.elements[key].value=definition[key];f.elements.name.dataset.edited='true';f.elements.stepTimeoutMinutes.value=definition.stepTimeoutMs/60000;f.elements.runTimeoutMinutes.value=definition.runTimeoutMs/60000;f.elements.inputJSON.value=JSON.stringify(definition.input,null,2);$('#script-input').value=definition.script;$('#script-input').dataset.edited='true';setMetadataForm(definition.metadata);updateLimitSummary();renderModeNote();}catch(e){error(e.message);}finally{use.disabled=false;}};
  remove.onclick=async()=>{if(!confirm(t('deleteTemplateConfirm')))return;remove.disabled=true;try{await api(`/templates/${template.id}`,'POST',{action:'delete'});await renderTemplates();}catch(e){error(e.message);remove.disabled=false;}};
  const actions=el('div',{class:'template-actions'});actions.append(use,remove);row.append(text,actions);list.append(row);
 }
}
async function openTemplates(){const f=$('#template-form');f.hidden=!current;f.elements.name.value=current?.name??'';f.dataset.runId=current?.id??'';f.dataset.revision=current?.revision??'';$('#templates-error').hidden=true;$('#templates-dialog').showModal();try{await renderTemplates();}catch(e){$('#templates-error').hidden=false;$('#templates-error').textContent=apiMessage(e.message);}}
$('#open-templates').onclick=openTemplates;$('#save-template').onclick=openTemplates;$('#close-templates').onclick=()=>$('#templates-dialog').close();
$('#template-form').onsubmit=async e=>{e.preventDefault();const f=e.currentTarget,button=e.submitter??f.querySelector('button[type=submit]');button.disabled=true;try{await api('/templates','POST',{runId:f.dataset.runId,name:f.elements.name.value,...(f.dataset.revision?{revision:Number(f.dataset.revision)}:{})});await renderTemplates();$('#templates-error').hidden=false;$('#templates-error').textContent=t('templateSaved');}catch(e){$('#templates-error').hidden=false;$('#templates-error').textContent=apiMessage(e.message);}finally{button.disabled=false;}};

function renderLegend(steps){const box=$('#graph-legend');box.replaceChildren();const states=showPlan||current?.status==='pending_review'?['planned']:['awaiting','queued','running','succeeded','failed',...(steps.some(s=>['blocked','not_run','interrupted'].includes(s.status))?['not_run']:[])];for(const state of states){const item=el('span',{class:`legend-state ${state}`});item.append(el('i',{'aria-hidden':'true'}),document.createTextNode(labels[state]));box.append(item);}}
