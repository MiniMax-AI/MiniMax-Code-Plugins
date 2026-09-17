import {expandStaticPlan} from './static-plan.mjs';
import {parse} from 'acorn';
import {validateScript} from './common.mjs';
// Parse only: never evaluate the workflow or fabricate agent results for a preview.
export function previewTopology(script,input={}) {
 const validation=validateScript(script),prefix='async function workflow(ctx,input){\n';
 const ast=parse(prefix+script+'\n}',{ecmaVersion:2023});
 const nodes=[],phases=[],declarations=[],calls=[],warnings=new Set();
 const text=n=>n?script.slice(Math.max(0,n.start-prefix.length),Math.max(0,n.end-prefix.length)):'';
 const literal=n=>n?.type==='Literal'?n.value:undefined;
 const prop=(n,key)=>n?.type==='ObjectExpression'?n.properties.find(p=>p.type==='Property'&&!p.computed&&((p.key.name??p.key.value)===key))?.value:undefined;
 const method=n=>n?.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.name==='ctx'?(n.callee.computed?literal(n.callee.property):n.callee.property.name):undefined;
 const children=n=>Object.values(n).flatMap(v=>Array.isArray(v)?v.filter(x=>x?.type):v?.type?[v]:[]);
 const refs=n=>{const out=new Set();function visit(x){if(!x)return;if(x.type==='Identifier')out.add(x.name);for(const c of children(x))visit(c);}visit(n);return out;};
 function walk(n,ancestors=[]){
  if(n.type==='VariableDeclarator'&&n.id.type==='Identifier')declarations.push(n);
  if(method(n)==='phase') {const spec=n.arguments[0],id=literal(prop(spec,'id')),label=literal(prop(spec,'label'));if(typeof id==='string'&&!phases.some(p=>p.id===id))phases.push({id,label:typeof label==='string'?label:id});else warnings.add('dynamicPhase');}
  if(method(n)==='agent')calls.push({n,ancestors});
  // The wrapper is not a dynamic function; nested functions may be called repeatedly.
  for(const c of children(n))walk(c,[...ancestors,n]);
 }
 walk(ast.body[0].body);
 if(calls.length>100){calls.length=100;warnings.add('truncated');}
 for(const {n,ancestors} of calls){
  const spec=n.arguments[0],id=literal(prop(spec,'id')),label=literal(prop(spec,'label')),phase=literal(prop(spec,'phase'));
  const repeated=ancestors.some(a=>/Function|ForStatement|ForOfStatement|ForInStatement|WhileStatement|DoWhileStatement/.test(a.type));
  const conditional=ancestors.some(a=>['IfStatement','ConditionalExpression','SwitchCase','LogicalExpression','CatchClause'].includes(a.type));
  const dynamic=repeated||typeof id!=='string';
  if(dynamic)warnings.add('dynamicNodes');if(conditional)warnings.add('conditionalNodes');
  const dep=prop(spec,'dependsOn'),deps=dep?.type==='ArrayExpression'?dep.elements.map(literal):typeof literal(dep)==='string'?[literal(dep)]:[];
  if(dep&&((dep.type!=='ArrayExpression'&&typeof literal(dep)!=='string')||deps.some(d=>typeof d!=='string')))warnings.add('dynamicDependencies');
  const offset=n.start-prefix.length;
  nodes.push({id:`plan:${offset}`,stepId:typeof id==='string'?id:null,label:(typeof label==='string'?label:typeof id==='string'?id:phases.find(p=>p.id===phase)?.label||text(prop(spec,'label'))||text(prop(spec,'id'))||'agent()').slice(0,120),phase:phases.some(p=>p.id===phase)?phase:null,kind:'agent',status:'planned',dynamic,conditional,dependsOn:[],declaredDependencies:deps.filter(d=>typeof d==='string'),line:script.slice(0,offset).split('\n').length,prompt:text(prop(spec,'prompt')).slice(0,1000),input:text(prop(spec,'input')).slice(0,1000),source:text(n).slice(0,2000),offset,end:n.end-prefix.length});
 }
 // Track data provenance conservatively. These edges mean data/control structure, not guaranteed dispatch.
 const producers=new Map(),edges=[];
 for(const d of declarations){const own=nodes.filter(n=>n.offset>=d.start-prefix.length&&n.end<=d.end-prefix.length).map(n=>n.id);const inherited=[...refs(d.init)].flatMap(r=>[...(producers.get(r)??[])]);producers.set(d.id.name,new Set([...own,...inherited]));}
 const add=(from,to,type)=>{if(from!==to&&!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to,type});};
 nodes.forEach((node,i)=>{
  const {n,ancestors}=calls[i];
  for(const dep of node.declaredDependencies){const targets=nodes.filter(x=>x.stepId===dep);if(targets.length)targets.forEach(x=>add(x.id,node.id,'declared'));else warnings.add('unresolvedDependencies');}
  const related=new Set(refs(n));
  for(const a of ancestors)if(a.type==='CallExpression'||/For/.test(a.type))for(const r of refs(a))related.add(r);
  for(const name of related)for(const from of producers.get(name)??[]){const producer=nodes.find(x=>x.id===from);if(producer?.offset<node.offset)add(from,node.id,'inferred');}
 });
 for(const node of nodes)node.dependsOn=edges.filter(e=>e.to===node.id).map(e=>e.from);
 if(!nodes.length)warnings.add('noStaticAgents');
 warnings.add('staticPreview');
 return expandStaticPlan({...validation,phases,nodes,edges,warnings:[...warnings]},script,input);
}
