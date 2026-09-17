const finished=new Set(['succeeded','completed_with_gaps','failed','cancelled']);
// Display-only states never become persisted scheduler states.
export function workflowGraph(run,{planOnly=false}={}){
 if(!run)return {nodes:[],phases:[]};
 const plan=run.topology?.nodes??[],actual=(run.steps??[]).filter(s=>s.kind==='agent'),claimed=new Set(),nodes=[],actualIds=new Map();
 const emptyStatus=run.status==='pending_review'?'planned':finished.has(run.status)?'not_run':'awaiting';
 for(const p of plan){
  const matches=actual.filter(s=>!claimed.has(s.id)&&(s.planId?(s.planId===(p.planId??p.id)&&(p.dynamic||!p.stepId||s.id===p.stepId)):p.stepId===s.id&&plan.filter(n=>n.stepId===s.id).length===1));
  if(planOnly){nodes.push({...p,placeholder:true,status:'planned'});continue;}
  if(!matches.length||p.dynamic&&!finished.has(run.status))nodes.push({...p,placeholder:true,status:emptyStatus});
  for(const s of matches){claimed.add(s.id);const id=p.dynamic?`live:${s.id}`:p.id;actualIds.set(s.id,id);nodes.push({...p,...s,id,actualId:s.id,placeholder:false,plannedDependsOn:p.dependsOn??[]});}
 }
 if(!planOnly)for(const s of actual)if(!claimed.has(s.id)){const id=`live:${s.id}`;actualIds.set(s.id,id);nodes.push({...s,id,actualId:s.id,placeholder:false});}
 const byId=new Map(nodes.map(n=>[n.id,n]));
 for(const n of nodes){
  if(!n.placeholder)n.dependsOn=(n.dependsOn??[]).map(id=>actualIds.get(id)).filter(Boolean);
  if(n.placeholder&&!planOnly&&!finished.has(run.status)&&n.dependsOn?.some(id=>run.topology?.edges?.some(e=>e.from===id&&e.to===n.id&&e.type==='declared')&&['failed','interrupted','blocked'].includes(byId.get(id)?.status)))n.status='blocked';
 }
 // Dynamic groups can expand into new phases; keep declared order and append real additions.
 const phases=[];for(const p of [...(run.topology?.phases??[]),...(run.phases??[])])if(!phases.some(x=>x.id===p.id))phases.push(p);
 for(const n of nodes)if(n.phase&&!phases.some(p=>p.id===n.phase))phases.push({id:n.phase,label:n.phase});
 return {nodes,phases};
}
