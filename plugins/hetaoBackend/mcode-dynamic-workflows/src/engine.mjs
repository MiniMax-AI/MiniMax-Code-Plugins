import {structuredOutput} from './structured-output.mjs';
import {normalizeDependencies,assertValidDependencies} from './dependencies.mjs';
import {workflowFailure,historicalFailure} from './workflow-errors.mjs';
import {instrumentWorkflow} from './static-plan.mjs';
import {normalizeMetadata,templateDefinition} from './definitions.mjs';
import { previewTopology } from './topology.mjs';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import Ajv from 'ajv';
import { check, hash, boundedJSON, validateScript } from './common.mjs';
import { resolveMcode } from './availability.mjs';
import { DEFAULT_LIMITS, LEGACY_LIMITS, resolveLimits, runLimits, durationLabel } from './limits.mjs';
import { agentFailure,failureError } from './failure.mjs';
import { demoExecute, mcodeExecute } from './executor.mjs';
export class Engine extends EventEmitter {
 constructor(store,options){super();this.store=store;this.options=options;this.defaults=resolveLimits(options,DEFAULT_LIMITS);this.globalConcurrency=this.store.setting('globalConcurrency')??8;this.lastServedRun=null;this.approving=new Set();this.active=new Map();this.slots=0;this.queue=[];this.closing=false;}
 async fingerprints(files=[]) {
   check(Array.isArray(files)&&files.length<=100,'files 最多 100 项');const root=await realpath(this.options.workspace);const out=Object.create(null);
   for(const path of files){
    check(typeof path==='string'&&!isAbsolute(path),'文件必须是工作区相对路径');
    const full=await realpath(resolve(root,path)),rel=relative(root,full);
    check(rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'文件超出工作区');
    // Nonblocking open avoids waiting on a FIFO before we can reject it.
    const file=await open(full,constants.O_RDONLY|(constants.O_NONBLOCK??0));
    try{
     const info=await file.stat();check(info.isFile(),'只支持普通文件');check(info.size<=1_000_000,'单文件超过 1MB');
     const data=Buffer.alloc(1_000_001);let length=0;
     while(length<data.length){const {bytesRead}=await file.read(data,length,data.length-length,null);if(!bytesRead)break;length+=bytesRead;}
     check(length<=1_000_000,'单文件超过 1MB');out[path]=hash(data.subarray(0,length));
    }finally{await file.close();}
   }return out;
 }
 async start(request,repair=null,candidates=[]) {
   check(!this.closing,'服务正在关闭');validateScript(request.script);boundedJSON(request.input??{});
   check(typeof request.requestId==='string'&&request.requestId.length<=150&&request.requestId.length>0,'必须提供 requestId');
   check(request.input===undefined||(request.input&&typeof request.input==='object'&&!Array.isArray(request.input)),'input 必须为 JSON object');
   check(['demo','mcode'].includes(request.executor),'executor 须为 demo 或 mcode');
   check(typeof request.name==='string'&&request.name.trim().length>0&&request.name.length<=120,'名称须为 1–120 字符');
   const concurrency=request.concurrency??4,maxCalls=request.maxCalls??20;
   check(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=16,'并发范围 1–16');check(Number.isInteger(maxCalls)&&maxCalls>=1&&maxCalls<=100,'调用数范围 1–100');
   const limits=resolveLimits(request,this.defaults);
   const metadata=request.metadata===undefined?{}:{metadata:normalizeMetadata(request.metadata)};
   // Absent unless explicitly true: an always-present default key would change requestHash and break legacy idempotent replays.
   const reuseAcrossRuns=request.reuseAcrossRuns===undefined?false:(check(typeof request.reuseAcrossRuns==='boolean','reuseAcrossRuns 必须为布尔'),request.reuseAcrossRuns);
   const definition={...limits,...metadata,name:request.name,script:request.script,input:request.input??{},executor:request.executor,concurrency,maxCalls,...(reuseAcrossRuns?{reuseAcrossRuns:true}:{})};const requestHash=hash(repair?{...definition,repair}:definition);
   const existing=this.store.byRequest(request.requestId);if(existing){const legacyDefinition={...definition};for(const key of Object.keys(DEFAULT_LIMITS))delete legacyDefinition[key];check(existing.requestHash===requestHash||(existing.maxSteps===undefined&&Object.keys(DEFAULT_LIMITS).every(k=>request[k]===undefined)&&existing.requestHash===hash(legacyDefinition)),'requestId 已用于不同参数');return this.snapshot(existing.id);}
   const fingerprints={};const topology=assertValidDependencies(previewTopology(request.script,request.input??{}));
   check(!this.closing,'服务正在关闭');
   const run={...(repair?{repair}:{}),id:randomUUID(),requestId:request.requestId,requestHash,...definition,scriptHash:hash(request.script),fingerprints,workspace:this.options.workspace,revision:1,topology,status:'pending_review',createdAt:Date.now(),updatedAt:Date.now(),attempts:0,phases:[],result:null,error:null};
   this.store.transaction(()=>{this.store.save(run);for(const step of candidates)this.store.saveRepairCandidate(run.id,step);this.store.event(run.id,'run.created',{name:run.name});});return this.snapshot(run.id);
 }
 async repair(id,request) {
   check(!this.closing,'服务正在关闭');const source=this.store.get(id);check(source,'工作流不存在');
   check(!this.active.has(id)&&['failed','paused','interrupted','cancelled','completed_with_gaps','succeeded'].includes(source.status),'请先停止运行；异常退出须先确认旧 Agent 已停止并恢复或暂停');
   check(source.workspace===this.options.workspace,'工作区不匹配');
   check(request.sourceUpdatedAt===source.updatedAt,'源运行已更新，请刷新后再修复');
   check(typeof request.script==='string','修复必须提供完整脚本');
   check(typeof request.reason==='string'&&request.reason.trim()&&request.reason.length<=2000,'请提供修复原因（最多 2000 字符）');
   const ids=request.reuseStepIds??[];check(Array.isArray(ids)&&ids.length<=100&&ids.every(v=>typeof v==='string')&&new Set(ids).size===ids.length,'reuseStepIds 必须为不重复的节点 ID 数组');
   const steps=this.store.steps(id),candidates=ids.map(id=>{const step=steps.find(s=>s.id===id);check(step?.kind==='agent'&&step.status==='succeeded'&&typeof step.requestHash==='string'&&Array.isArray(step.dependsOn),`节点 ${id} 不是可复用的成功节点`);return step;});
   // Freeze results at fork creation; later resumes of the source must not change this draft.
   const repair={sourceRunId:id,sourceUpdatedAt:source.updatedAt,sourceRevision:source.revision??null,reason:request.reason.trim(),reuseStepIds:ids,candidateStepIds:ids,
     contextHash:hash({workspace:source.workspace,input:source.input,executor:source.executor,fingerprints:source.fingerprints}),
     sourceError:source.error??null,failures:steps.filter(s=>s.status!=='succeeded').map(s=>({id:s.id,status:s.status,error:s.error??null}))};
   return this.start({...templateDefinition(source),...request},repair,candidates);
 }
 async update(id,request) {
   check(!this.closing,'服务正在关闭');const run=this.store.get(id);check(run?.status==='pending_review','只有待审核工作流可以修改');
   check(Number.isInteger(request.revision)&&request.revision===run.revision,'审核版本已更新，请刷新后再修改');
   const script=request.script??run.script,input=request.input??run.input,topology=assertValidDependencies(previewTopology(script,input));
   check(input&&typeof input==='object'&&!Array.isArray(input),'input 必须为 JSON object');boundedJSON(input);
   const name=request.name??run.name,executor=request.executor??run.executor,concurrency=request.concurrency??run.concurrency,maxCalls=request.maxCalls??run.maxCalls,reuseAcrossRuns=request.reuseAcrossRuns===undefined?run.reuseAcrossRuns:(check(typeof request.reuseAcrossRuns==='boolean','reuseAcrossRuns 必须为布尔'),request.reuseAcrossRuns);
   check(typeof name==='string'&&name.trim().length>0&&name.length<=120,'名称须为 1–120 字符');check(['demo','mcode'].includes(executor),'executor 须为 demo 或 mcode');
   check(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=16,'并发范围 1–16');check(Number.isInteger(maxCalls)&&maxCalls>=1&&maxCalls<=100,'调用数范围 1–100');
   const metadata=request.metadata===undefined?{}:{metadata:normalizeMetadata(request.metadata)};
   let repair=run.repair;
   if(request.reuseStepIds!==undefined){const ids=request.reuseStepIds;check(repair&&Array.isArray(ids)&&ids.length<=100&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&(repair.candidateStepIds??repair.reuseStepIds).includes(id)),'只能选择修复草稿已冻结的候选节点');repair={...repair,reuseStepIds:ids};}
   if(request.reason!==undefined){check(repair&&typeof request.reason==='string'&&request.reason.trim()&&request.reason.length<=2000,'请提供修复原因（最多 2000 字符）');repair={...repair,reason:request.reason.trim()};}
   Object.assign(run,...(repair?[{repair}]:[]),resolveLimits(request,runLimits(run)),metadata,{name,script,input,executor,concurrency,maxCalls,reuseAcrossRuns,topology,scriptHash:hash(script),revision:run.revision+1});
   this.save(run);this.emitEvent(id,'run.updated',{revision:run.revision});return this.snapshot(id);
 }
 saveTemplate(id,{name,revision}={}) {
   check(!this.closing,'服务正在关闭');const run=this.snapshot(id);
   check(revision===run.revision,'工作流版本已更新，请刷新后保存模板');
   check(typeof name==='string'&&name.trim()&&name.length<=120,'模板名称须为 1–120 字符');
   check(this.store.templates().length<50,'模板最多 50 个，请删除不需要的模板');
   const template={id:randomUUID(),name:name.trim(),createdAt:Date.now(),definition:templateDefinition(run)};
   this.store.saveTemplate(template);return template;
 }
 async approve(id,{revision}={}) {
   check(!this.closing,'服务正在关闭');let run=this.store.get(id);check(run?.status==='pending_review','工作流不在待审核状态');
   check(Number.isInteger(revision)&&revision===run.revision,'审核版本已更新，请刷新拓扑后再开始');assertValidDependencies(previewTopology(run.script,run.input));check(!this.approving.has(id),'工作流正在启动');this.approving.add(id);
   try {
    if(run.executor==='mcode'&&!this.options.execute)check(await resolveMcode(this.options.command??'mcode'),'找不到 MCode CLI，请安装并登录后开始。');
    const fingerprints=await this.fingerprints(run.input.files??[]);
    run=this.store.get(id);check(run?.status==='pending_review'&&run.revision===revision,'审核版本已更新，请刷新拓扑后再开始');
    check(!this.closing&&!this.active.has(id)&&this.active.size<3,'服务正在关闭或执行容量已满');
    check(run.workspace===this.options.workspace,'工作区已改变，请创建新工作流');
    Object.assign(run,{fingerprints,approvedRevision:revision,approvedAt:Date.now()});this.save(run);this.emitEvent(id,'run.approved',{revision});this.launch(run);return this.snapshot(id);
   } finally {this.approving.delete(id);}
 }
 snapshot(id){const run=this.store.get(id);check(run,'工作流不存在');const limits=runLimits(run),topology=run.topology?.version===3?run.topology:previewTopology(run.script,run.input);return {...run,topology,...historicalFailure(run,topology),...limits,legacyLimits:run.maxSteps===undefined,scheduler:this.schedulerStatus(),steps:this.store.steps(id).map(stored=>{const s=stored.kind==='agent'?{...stored,maxSteps:stored.maxSteps??LEGACY_LIMITS.maxSteps,timeoutMs:stored.timeoutMs??LEGACY_LIMITS.stepTimeoutMs}:stored;if(!s.errorDetails&&/^MCode (limit_exceeded|timeout)$/.test(s.error??'')){const errorDetails=agentFailure(s.error.slice(6),{maxSteps:s.maxSteps??limits.maxSteps,timeoutMs:s.timeoutMs??limits.stepTimeoutMs,sessionId:s.sessionId,turnId:s.turnId});return {...s,error:errorDetails.message,errorDetails};}return s.status==='queued'?{...s,queueInfo:this.queueInfo(id,s.id)}:s;})};}
 queueInfo(runId,stepId){
  const ticket=this.queue.find(t=>t.ctx.run.id===runId&&t.stepId===stepId),ctx=this.active.get(runId);
  return {reason:this.slots>=this.globalConcurrency?'global_capacity':ctx&&ctx.slots>=ctx.run.concurrency?'run_capacity':'dispatch',globalActive:this.slots,globalLimit:this.globalConcurrency,runActive:ctx?.slots??0,runLimit:ctx?.run.concurrency??0,position:ticket?this.queue.indexOf(ticket)+1:null,blockingRuns:[...this.active.values()].filter(c=>c.slots>0).map(c=>({id:c.run.id,name:c.run.name,active:c.slots}))};
 }
 emitEvent(id,type,data={}){const e=this.store.event(id,type,data);this.emit('change',{runId:id,...e});return e;}
 save(run){run.updatedAt=Date.now();this.store.save(run);}
 acquire(signal,ctx,stepId){return new Promise((res,rej)=>{
   const ticket={signal,ctx,stepId,res,rej};const abort=()=>{const i=this.queue.indexOf(ticket);if(i>=0)this.queue.splice(i,1);rej(new Error('执行已停止'));};ticket.abort=abort;
   if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true});this.queue.push(ticket);this.drain();
 });}
 schedulerStatus(){return {active:this.slots,limit:this.globalConcurrency,queued:this.queue.length,perRunDefault:4,perRunMax:16};}
 configureScheduler({globalConcurrency}){
  check(!this.closing,'服务正在关闭');check(Number.isInteger(globalConcurrency)&&globalConcurrency>=1&&globalConcurrency<=32,'全局并发须为 1–32 的整数');
  this.store.saveSetting('globalConcurrency',globalConcurrency);this.globalConcurrency=globalConcurrency;
  // Reducing capacity never interrupts a running agent. Only new dispatch is limited.
  this.drain();return this.schedulerStatus();
 }
 drain(){
  while(this.slots<this.globalConcurrency){
   const ids=[...this.active.keys()],last=ids.indexOf(this.lastServedRun);let index=-1;
   for(let offset=1;offset<=ids.length;offset++){
    const id=ids[(last+offset)%ids.length];index=this.queue.findIndex(t=>t.ctx.run.id===id&&!t.signal.aborted&&t.ctx.slots<t.ctx.run.concurrency);
    if(index!==-1)break;
   }
   if(index===-1)return;
   const [t]=this.queue.splice(index,1);t.signal.removeEventListener('abort',t.abort);this.lastServedRun=t.ctx.run.id;
   this.slots++;t.ctx.slots++;let released=false;
   t.res(()=>{if(released)return;released=true;this.slots--;t.ctx.slots--;this.drain();});
  }
 }

 launch(run){
   const ctx={run,controller:new AbortController(),worker:null,slots:0,operations:new Set(),calls:new Map(),intent:null};this.active.set(run.id,ctx);run.status='running';run.latestProgress=null;run.error=null;run.errorDetails=null;run.result=null;this.save(run);this.emitEvent(run.id,'run.started');
   const worker=new Worker(new URL('./sandbox.mjs',import.meta.url),{workerData:{script:instrumentWorkflow(run.script),input:run.input},resourceLimits:{maxOldGenerationSizeMb:128}});ctx.worker=worker;
   const limits=runLimits(run);const overall=setTimeout(()=>{ctx.intent='failed';ctx.failure={code:'WORKFLOW_TIMEOUT',message:`工作流本次执行达到 ${durationLabel(limits.runTimeoutMs)} 整体时限，已停止所有在途节点。`,suggestion:'提高工作流整体时限后恢复，或缩小任务范围。',runTimeoutMs:limits.runTimeoutMs};ctx.reason=ctx.failure.message;run.errorDetails=ctx.failure;ctx.controller.abort();worker.terminate();finish(false,ctx.reason);},limits.runTimeoutMs);overall.unref();
   let finishing=false;
   const finish=async(ok,value)=>{
     if(finishing)return;finishing=true;clearTimeout(overall);
     if(!ok||ctx.intent){ctx.controller.abort();await worker.terminate();}
     await Promise.allSettled([...ctx.operations]);await worker.terminate();
     const steps=this.store.steps(run.id);
     run.status=ctx.intent??(ok?(steps.some(s=>s.status!=='succeeded')?'completed_with_gaps':'succeeded'):'failed');
     if(ok&&!ctx.intent){try{boundedJSON(value,100_000);run.result=value;}catch(e){run.status='failed';run.error=e.message;}}
     else {const failure=workflowFailure(value);run.error=ctx.reason??failure.message;run.errorDetails=ctx.failure??failure.details??run.errorDetails;}
     for(const s of steps)if(['running','queued'].includes(s.status)){s.status='interrupted';s.endedAt=Date.now();this.store.saveStep(run.id,s);}
     this.save(run);this.active.delete(run.id);this.emitEvent(run.id,'run.finished',{status:run.status,error:run.error});ctx.resolveDone?.();
   };
   ctx.done=new Promise(r=>{ctx.resolveDone=r;});ctx.finish=finish;
   worker.on('message',msg=>{if(msg.type==='done'){void finish(msg.ok,msg.value);return;}if(msg.type!=='call'||finishing)return;
     const p=this.call(ctx,msg.method,msg.payload).then(value=>{if(!finishing)worker.postMessage({id:msg.id,ok:true,value:value??null});},e=>{if(!finishing)worker.postMessage({id:msg.id,ok:false,error:e.message,details:e.details});});ctx.operations.add(p);p.finally(()=>ctx.operations.delete(p));
   });worker.on('error',e=>void finish(false,e.message));worker.on('exit',code=>{if(!finishing)void finish(false,`脚本解释器退出 ${code}`);});
 }
 async call(ctx,method,payload){ctx.controller.signal.throwIfAborted();boundedJSON(payload);
   if(method==='agent')return this.agent(ctx,payload.spec,payload.planId);
   if(method==='phase'){check(payload&&typeof payload.id==='string'&&payload.id.length<=100&&typeof payload.label==='string'&&payload.label.length<=120,'phase 须含 id/label');const old=ctx.run.phases.find(p=>p.id===payload.id);if(old){check(old.label===payload.label,'阶段 ID 定义冲突');return old;}check(ctx.run.phases.length<30,'阶段过多');ctx.run.phases.push({id:payload.id,label:payload.label});this.save(ctx.run);this.emitEvent(ctx.run.id,'phase.created',payload);return payload;}
   if(method==='log'){
     check((ctx.logs=(ctx.logs??0)+1)<=200,'日志数量超过限制');
     check(typeof payload.message==='string'&&payload.message.length<=4000,'日志最多 4000 字符');
     const detail={message:payload.message};
     for(const key of ['stepId','phase'])if(payload[key]!==undefined){check(typeof payload[key]==='string'&&/^[A-Za-z0-9_:./-]{1,150}$/.test(payload[key]),'日志关联 ID 无效');detail[key]=payload[key];}
     ctx.run.latestProgress={...detail,time:Date.now()};this.save(ctx.run);this.emitEvent(ctx.run.id,'log',detail);return;
   }
   if(method==='checkpoint'){check(typeof payload.id==='string'&&payload.id.length<=100,'checkpoint 必须有 ID');const key=`checkpoint:${payload.id}`,old=this.store.step(ctx.run.id,key);if(old){check(old.requestHash===hash(payload),'checkpoint 参数冲突');return old.output;}const checkpointHash=hash(payload);// Checkpoints recompute every run; their lineage hash covers the recomputed value so a changed value breaks downstream cross-run lineage.
const step={id:key,kind:'checkpoint',status:'succeeded',output:payload.value,requestHash:checkpointHash,lineageHash:hash({requestHash:checkpointHash,deps:[]}),label:payload.id,dependsOn:[],createdAt:Date.now()};this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'checkpoint',{stepId:key});return payload.value;}
   throw new Error('未知脚本操作');
 }
 agent(ctx,spec,planId){
   check(spec&&typeof spec.id==='string'&&/^[A-Za-z0-9_:./-]{1,150}$/.test(spec.id)&&!spec.id.startsWith('checkpoint:'),'step id 无效');
   check(typeof spec.prompt==='string'&&spec.prompt.length>0&&spec.prompt.length<=30_000,'prompt 须为 1–30000 字符');
   check(!spec.label||typeof spec.label==='string'&&spec.label.length<=120,'label 无效');check(!spec.phase||ctx.run.phases.some(p=>p.id===spec.phase),'phase 尚未声明');
   for(const key of ['model','effort'])if(spec[key]!==undefined)check(typeof spec[key]==='string'&&spec[key].length>0&&spec[key].length<=200,`${key} 无效`);
   const node=ctx.run.topology?.nodes.find(n=>(n.planId??n.id)===planId),line=node?.dependencyLine??node?.line;
   const deps=normalizeDependencies(spec.dependsOn,{stepId:spec.id,line});
   for(const dep of deps){const status=this.store.step(ctx.run.id,dep)?.status??'not_created';if(status!=='succeeded')throw failureError({code:'DEPENDENCY_NOT_READY',stepId:spec.id,dependency:dep,dependencyStatus:status,line,message:`节点 ${spec.id} 不能启动：依赖 ${dep} 尚未成功（状态 ${status}）。`,suggestion:'先 await 上游并检查 status。需要继续处理部分结果时，只声明已成功节点的 ID，同时在结果中保留失败与覆盖缺口。'});}
   if(typeof spec.dependsOn==='string')spec={...spec,dependsOn:deps};
   // Each node owns its schema namespace and compiler lifetime. A repeated $id
   // in another node/run must neither conflict nor retain schemas indefinitely.
   const validateOutput=spec.schema===undefined?null:new Ajv({strict:false,allErrors:true,addUsedSchema:false}).compile(spec.schema);
   const requestHash=hash(spec),previous=this.store.step(ctx.run.id,spec.id),cached=ctx.calls.get(spec.id);
   if(previous){check(previous.requestHash===requestHash,`步骤 ${spec.id} 使用了不同参数，恢复已停止`);if(previous.status==='succeeded')return Promise.resolve({status:'succeeded',output:previous.output,cached:true});}
   if(cached){check(cached.hash===requestHash,'重复 step id 参数冲突');return cached.promise;}
   // Computed once per dispatch attempt, before any candidate lookup. contextHash is
   // stamped on every new step so the store can filter cross-run candidates in SQL
   // before LIMIT; lineageHash pins the node to its own spec plus, for each
   // succeeded dependency (in dependsOn order), that dependency's lineage hash
   // AND output hash — so a changed, rerun, or differently-outcomed upstream
   // invalidates downstream candidates even when the downstream spec is unchanged.
   const ctxHash=ctx.contextHash??(ctx.contextHash=hash({workspace:ctx.run.workspace,input:ctx.run.input,executor:ctx.run.executor,fingerprints:ctx.run.fingerprints}));
   const lineageHash=hash({requestHash,deps:deps.map(id=>{const dep=this.store.step(ctx.run.id,id);return {id,lineageHash:dep?.lineageHash??null,outputHash:dep?.status==='succeeded'?hash(dep.output??null):null};})});
   const repair=ctx.run.repair,candidate=!previous&&repair?.reuseStepIds.includes(spec.id)?this.store.repairCandidate(ctx.run.id,spec.id):null;
   if(candidate&&candidate.requestHash===requestHash
      &&repair.contextHash===hash({workspace:ctx.run.workspace,input:ctx.run.input,executor:ctx.run.executor,fingerprints:ctx.run.fingerprints})
      &&deps.every(id=>{const dep=this.store.step(ctx.run.id,id);return dep?.reusedFrom?.runId===repair.sourceRunId
       // Checkpoints recompute every run by design; reuse stays valid while the
       // recomputed value matches the source run, breaking lineage if it changed.
       ||(dep?.kind==='checkpoint'&&dep.requestHash===this.store.step(repair.sourceRunId,id)?.requestHash);})){
     // Recheck the output against today's validator, including legacy candidates.
     let valid=true;try{if(validateOutput)valid=validateOutput(candidate.output);}catch{valid=false;}
     if(valid){const step={...candidate,...(typeof planId==='string'?{planId}:{}),attempt:0,createdAt:Date.now(),startedAt:null,endedAt:Date.now(),usage:null,usageHistory:[],sessionId:undefined,turnId:undefined,contextHash:ctxHash,
       reusedFrom:{runId:repair.sourceRunId,stepId:spec.id,endedAt:candidate.endedAt??null},
       // The first producer survives repair chains: R2/R3 relay the output but
       // only the original execution produced it.
       originalProducer:candidate.originalProducer??(candidate.reusedFrom?{...candidate.reusedFrom}:{runId:repair.sourceRunId,stepId:spec.id,endedAt:candidate.endedAt??null})};
       this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'step.reused',{stepId:step.id,sourceRunId:repair.sourceRunId});
       return Promise.resolve({status:'succeeded',output:step.output,cached:true});}
   }
   // A freshly executed agent dependency has unproven execution identity: spec and
   // output hashes cannot see changed filesystem effects (same return value, different
   // written content). Downstream adoption is therefore only sound when every agent
   // dependency was itself adopted/reused; checkpoints recompute deterministically and
   // their value hash is already bound into lineage.
   const depsAllAdopted=deps.every(id=>{const dep=this.store.step(ctx.run.id,id);return dep?.kind==='checkpoint'||dep?.reusedFrom;});
   if(ctx.run.reuseAcrossRuns&&!previous&&depsAllAdopted&&!(ctx.run.executor==='mcode'&&!spec.model)){
    // Cross-run reuse: adopt an earlier run's stored result when the node spec, its
    // upstream lineage and the run context (workspace, input, executor, tracked
    // files) all hash identically. All three keys are stamped on candidate steps at
    // creation, so the store filters in SQL before LIMIT. mcode nodes without an
    // explicit model are never candidates: the effective model comes from the CLI
    // environment and is not part of the match key.
    for(const candidate of this.store.findCrossRunReuse({contextHash:ctxHash,requestHash,lineageHash,excludeRunId:ctx.run.id})){
     let valid=true;try{if(validateOutput)valid=validateOutput(candidate.step.output);}catch{valid=false;}
     if(!valid)continue;
     const source=candidate.step;
     // lineageHash is adopted from the source (dependencies already matched, so the
     // lineage is equivalent); contextHash is restamped with this run's. Provenance
     // always records the immediate source in reusedFrom and the first producer in
     // originalProducer, so chained adoptions stay consistent with the emitted event.
     const step={...source,attempt:0,createdAt:Date.now(),startedAt:null,endedAt:source.endedAt??Date.now(),usage:null,usageHistory:[],sessionId:undefined,turnId:undefined,contextHash:ctxHash,
       // planId must follow the CURRENT dispatch: keeping the source run's planId
       // duplicates/mislabels the node against this run's topology (the repair
       // path already restamps it).
       ...(typeof planId==='string'?{planId}:{planId:undefined}),
       reusedFrom:{runId:candidate.runId,stepId:candidate.stepId,endedAt:source.endedAt??null,crossRun:true},
       originalProducer:source.originalProducer??(source.reusedFrom?{...source.reusedFrom}:{runId:candidate.runId,stepId:candidate.stepId,endedAt:source.endedAt??null,crossRun:true})};
     this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'step.reused',{stepId:spec.id,sourceRunId:candidate.runId,crossRun:true});
     return Promise.resolve({status:'succeeded',output:step.output,cached:true});
    }
   }
   check(ctx.run.attempts<ctx.run.maxCalls,`已达到工作流 Agent 总调用上限 ${ctx.run.maxCalls} 次（包括恢复尝试），请提高总调用预算后恢复。`);ctx.run.attempts++;this.save(ctx.run);
   const step={id:spec.id,...(typeof planId==='string'?{planId}:{}),label:spec.label??spec.id,phase:spec.phase??null,kind:'agent',dependsOn:deps,requestHash,contextHash:ctxHash,lineageHash,status:'queued',attempt:(previous?.attempt??0)+1,createdAt:previous?.createdAt??Date.now(),startedAt:null,endedAt:null,prompt:spec.prompt,input:spec.input??null,output:null,error:null,errorDetails:null,...runLimits(ctx.run),timeoutMs:runLimits(ctx.run).stepTimeoutMs,usage:null,usageHistory:[...(previous?.usageHistory??[]),...(previous?.usage?[previous.usage]:[])]};
   this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'step.queued',{stepId:step.id});
   const promise=(async()=>{
    let release;try{release=await this.acquire(ctx.controller.signal,ctx,step.id);ctx.controller.signal.throwIfAborted();step.status='running';step.startedAt=Date.now();this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'step.started',{stepId:step.id});
      const executor=this.options.execute??(ctx.run.executor==='demo'?demoExecute:mcodeExecute);
      const answer=await executor(spec,{...this.options,signal:ctx.controller.signal,timeoutMs:step.timeoutMs,maxSteps:step.maxSteps,onEvent:e=>{if(e.sessionId){step.sessionId=e.sessionId;step.turnId=e.turnId;this.store.saveStep(ctx.run.id,step);}this.emitEvent(ctx.run.id,'step.progress',{stepId:step.id,...e});}});
      step.usage=answer.usage??null;step.sessionId=answer.sessionId??step.sessionId;step.turnId=answer.turnId??step.turnId;boundedJSON(answer.output,100_000);let output=answer.output;if(validateOutput){step.rawOutput=answer.output;const normalized=structuredOutput(answer.output,validateOutput,step.id);output=normalized.output;step.outputFormat=normalized.format;}
      step.status='succeeded';step.output=output;step.usage=answer.usage??null;step.sessionId=answer.sessionId??step.sessionId;step.turnId=answer.turnId??step.turnId;
    }catch(e){
      if(e.details?.code==='MCODE_CLEANUP_UNCONFIRMED'){
        ctx.intent='needs_attention';ctx.failure=e.details;ctx.reason=e.message;
        ctx.controller.abort();void ctx.finish(false,e.message);
      }
      step.status=ctx.controller.signal.aborted?'interrupted':'failed';step.error=ctx.controller.signal.aborted?(ctx.reason??e.message):e.message??String(e);step.errorDetails=ctx.failure??e.details??{code:ctx.controller.signal.aborted?'RUN_INTERRUPTED':'STEP_FAILED',message:step.error};step.usage=e.usage??step.usage;}finally{step.endedAt=Date.now();this.store.saveStep(ctx.run.id,step);this.emitEvent(ctx.run.id,'step.finished',{stepId:step.id,status:step.status,error:step.error});release?.();}
    return {status:step.status,output:step.output,error:step.error,errorDetails:step.errorDetails};
   })();ctx.calls.set(spec.id,{hash:requestHash,promise});return promise;
 }
 async stop(id,intent='cancelled'){const ctx=this.active.get(id);if(!ctx){const run=this.store.get(id);if(run?.status==='pending_review'&&intent==='cancelled'){run.status='cancelled';this.save(run);this.emitEvent(id,'run.finished',{status:'cancelled'});}return this.snapshot(id);}if(ctx.intent==='needs_attention'){await ctx.done;return this.snapshot(id);}ctx.intent=intent;ctx.reason=intent==='paused'?'用户暂停，已完成结果可复用':'用户取消';ctx.run.status=intent==='paused'?'pausing':'stopping';this.save(ctx.run);this.emitEvent(id,'run.stopping',{intent});ctx.controller.abort();void ctx.finish(false,ctx.reason);await ctx.done;return this.snapshot(id);}
 async resume(id,options={}){
   check(!this.closing,'服务正在关闭');const run=this.store.get(id);check(run,'工作流不存在');check(!this.active.has(id),'工作流仍在运行');check(run.workspace===this.options.workspace,'工作区已改变，请创建新工作流');
   check(!run.revision||run.approvedRevision===run.revision,'未审核工作流不能恢复，请创建新草稿');
   check(['paused','failed','interrupted','cancelled','needs_attention','completed_with_gaps'].includes(run.status),'当前状态不能恢复');check(run.status!=='needs_attention'||options.confirmStopped===true,'上次异常退出，需确认旧 Agent 已停止');
   if(run.executor==='mcode'&&!this.options.execute)check(await resolveMcode(this.options.command??'mcode'),'找不到 MCode CLI，请安装并登录后恢复。');
   assertValidDependencies(previewTopology(run.script,run.input));
   const limits=resolveLimits(options,runLimits(run)),maxCalls=options.maxCalls??run.maxCalls;
   check(Number.isInteger(maxCalls)&&maxCalls>=1&&maxCalls<=100,'调用数范围 1–100');check(run.attempts<maxCalls,`已使用 ${run.attempts} 次 Agent 调用，请将总调用上限设置得更高后恢复。`);
   check(this.active.size<3,'运行中工作流过多');check(hash(await this.fingerprints(run.input.files??[]))===hash(run.fingerprints),'源文件已改变，请创建新工作流');check(!this.closing&&!this.active.has(id)&&this.active.size<3,'工作流已运行或执行容量已满');
   Object.assign(run,limits,{maxCalls});this.save(run);this.emitEvent(id,'run.limits',{...limits,maxCalls});this.launch(run);return this.snapshot(id);
 }
 async close(){this.closing=true;await Promise.all([...this.active.keys()].map(id=>this.stop(id,'interrupted')));}
}
