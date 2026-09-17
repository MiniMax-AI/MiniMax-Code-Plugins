// Decode the old JSON-string rejection envelope, without evaluating arbitrary error text.
export function workflowFailure(value){
 let decoded=value,details=null;
 for(let i=0;i<5;i++){
  if(typeof decoded==='string'){try{const next=JSON.parse(decoded);if(typeof next==='string'||next&&typeof next==='object'){decoded=next;continue;}}catch{}break;}
  if(decoded?.details&&typeof decoded.details==='object'&&!Array.isArray(decoded.details))details=decoded.details;
  if(decoded&&typeof decoded==='object'&&typeof decoded.error==='string'&&!decoded.message){decoded=decoded.error;continue;}break;
 }
 const message=typeof decoded==='string'?decoded:typeof decoded?.message==='string'?decoded.message:typeof value==='string'?value:'工作流执行失败';
 return {message,details};
}
export function historicalFailure(run,topology){
 if(!run.error)return {};
 const decoded=workflowFailure(run.error);if(run.errorDetails||run.topology?.version===3||decoded.message!=='依赖无效')return {error:decoded.message};
 const candidates=topology.nodes.filter(n=>n.dependencyShorthand&&n.declaredDependencies.length&&n.declaredDependencies[0]!==n.stepId);
 if(!candidates.length)return {error:decoded.message};
 const node=candidates[0],dependency=node.declaredDependencies[0];
 const details={code:'LEGACY_DEPENDENCY_STRING',stepId:node.stepId,line:node.dependencyLine,dependency,message:`历史运行因依赖格式被旧版拒绝而停止：脚本使用 dependsOn: "${dependency}"。当前版本已支持此写法。`,cause:decoded.message,suggestion:'点击恢复可继续执行，已成功的节点会复用，不会因刷新页面自动重跑。'};
 return {error:details.message,errorDetails:details};
}
