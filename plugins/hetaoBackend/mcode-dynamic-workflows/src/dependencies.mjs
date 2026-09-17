import {failureError} from './failure.mjs';
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_:./-]{1,150}$/.test(id);
export function normalizeDependencies(value,{stepId,line}={}){
 const deps=value==null?[]:typeof value==='string'?[value]:value;
 const location=`节点 ${stepId??'(动态 ID)'}${line?`（脚本第 ${line} 行）`:''}`;
 const invalid=reason=>{throw failureError({code:'DEPENDENCY_INVALID',stepId,line,field:'dependsOn',message:`${location} 的 dependsOn 无效：${reason}`,suggestion:'使用单个节点 ID 字符串或节点 ID 数组，例如 dependsOn: ["scope"]；依赖不能包含自身。'});};
 if(!Array.isArray(deps))invalid(`需要节点 ID 字符串或数组，实际为 ${typeof value}`);
 if(deps.length>100)invalid('最多允许 100 个依赖');
 for(let i=0;i<deps.length;i++){if(!validId(deps[i]))invalid(`第 ${i+1} 项必须为 1–150 字符的节点 ID（字母、数字或 _ : . / -）`);if(deps[i]===stepId)invalid(`不能依赖自身 ${stepId}`);}
 return deps;
}
export function assertValidDependencies(topology){if(topology.issues?.length)throw failureError(topology.issues[0]);return topology;}
