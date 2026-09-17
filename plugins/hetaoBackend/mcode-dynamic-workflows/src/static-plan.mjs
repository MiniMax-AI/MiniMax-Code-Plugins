import {normalizeDependencies} from './dependencies.mjs';
import {parse} from 'acorn';
const UNKNOWN=Symbol('unknown');
const prefix='async function workflow(ctx,input){\n';
const children=n=>Object.values(n).flatMap(v=>Array.isArray(v)?v.filter(x=>x?.type):v?.type?[v]:[]);
const method=n=>n?.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object.name==='ctx'?(n.callee.computed?n.callee.property.value:n.callee.property.name):null;
const prop=(n,key)=>n?.type==='ObjectExpression'?n.properties.find(p=>p.type==='Property'&&!p.computed&&(p.key.name??p.key.value)===key)?.value:null;
function inspect(script){const root=parse(prefix+script+'\n}',{ecmaVersion:2023}).body[0].body,parents=new Map(),agents=[];function walk(n,ancestors=[]){parents.set(n,ancestors);if(method(n)==='agent')agents.push(n);for(const c of children(n))walk(c,[...ancestors,n]);}walk(root);return {root,parents,agents};}
// Never evaluate user code. Only resolve a small JSON-expression subset and lexical const bindings.
export function expandStaticPlan(base,script,input={}){
 const {parents,agents}=inspect(script);
 function value(n,bindings=new Map(),seen=new Set()){
  if(!n||seen.has(n)||seen.size>60)return UNKNOWN;seen=new Set(seen).add(n);
  const read=x=>value(x,bindings,seen);
  if(n.type==='Literal')return n.regex||typeof n.value==='bigint'?UNKNOWN:n.value;
  if(n.type==='Identifier'){
   for(const scope of [...parents.get(n)].reverse()){
    if(/Function/.test(scope.type)&&scope.params?.some(p=>p.type!=='Identifier'||p.name===n.name))return bindings.has(n.name)?bindings.get(n.name):UNKNOWN;
    if(scope.type!=='BlockStatement')continue;
    for(const statement of scope.body){if(statement.type!=='VariableDeclaration')continue;for(const d of statement.declarations)if(d.id.type==='Identifier'&&d.id.name===n.name)return statement.kind==='const'&&d.end<n.start?read(d.init):UNKNOWN;}
   }
   return n.name==='input'?input:UNKNOWN;
  }
  if(n.type==='ArrayExpression'&&n.elements.length<=100){const a=n.elements.map(read);return a.includes(UNKNOWN)?UNKNOWN:a;}
  if(n.type==='ObjectExpression'&&n.properties.length<=100){const out=Object.create(null);for(const p of n.properties){if(p.type!=='Property'||p.computed||p.kind!=='init'||p.method)return UNKNOWN;const v=read(p.value);if(v===UNKNOWN)return UNKNOWN;out[p.key.name??p.key.value]=v;}return out;}
  if(n.type==='MemberExpression'){const o=read(n.object),k=n.computed?read(n.property):n.property.name;return o!==UNKNOWN&&o!==null&&typeof o==='object'&&k!==UNKNOWN&&Object.hasOwn(o,k)?o[k]:UNKNOWN;}
  if(n.type==='TemplateLiteral'){const vs=n.expressions.map(read);if(vs.some(v=>v===UNKNOWN||v!==null&&typeof v==='object'))return UNKNOWN;return n.quasis.map((q,i)=>q.value.cooked+(i<vs.length?String(vs[i]):'')).join('').slice(0,2000);}
  if(n.type==='BinaryExpression'&&n.operator==='+'){const a=read(n.left),b=read(n.right);if(['string','number'].includes(typeof a)&&['string','number'].includes(typeof b))return String(a+b).length<=2000?a+b:UNKNOWN;}
  return UNKNOWN;
 }
 const records=[],issues=[];let expandedCount=base.nodes.length;
 for(const node of base.nodes){
  const call=agents.find(a=>a.start-prefix.length===node.offset);if(!call){records.push({...node,planId:node.id});continue;}
  const ancestors=parents.get(call),maps=ancestors.filter(n=>method(n)==='map'),nestedFunctions=ancestors.filter(n=>/Function/.test(n.type));
  let instances=[new Map()],group=null;
  if(maps.length===1&&nestedFunctions.length===1&&maps[0].arguments[1]===nestedFunctions[0]){
   const items=value(maps[0].arguments[0]),params=nestedFunctions[0].params;
   if(Array.isArray(items)&&items.length>0&&params.length<=2&&params.every(p=>p.type==='Identifier')&&expandedCount+items.length-1<=100){group=maps[0].start;instances=items.map((item,i)=>new Map(params.map((p,j)=>[p.name,j===0?item:i])));}
  }
  const candidates=instances.map((bindings,index)=>{
   const spec=call.arguments[0],id=value(prop(spec,'id'),bindings),label=value(prop(spec,'label'),bindings),depNode=prop(spec,'dependsOn'),deps=depNode?value(depNode,bindings):[];
   const dependencyLine=depNode?script.slice(0,depNode.start-prefix.length).split('\n').length:null;
   let declaredDependencies=node.declaredDependencies;
   if(deps!==UNKNOWN)try{declaredDependencies=normalizeDependencies(deps,{stepId:typeof id==='string'?id:undefined,line:dependencyLine});}catch(e){issues.push(e.details);}

   return {...node,id:group?`${node.id}:${index}`:node.id,planId:node.id,stepId:typeof id==='string'?id:node.stepId,label:typeof label==='string'?label:typeof id==='string'?id:node.label,dynamic:typeof id!=='string'||(!group&&node.dynamic),group,index,declaredDependencies,dependenciesKnown:deps!==UNKNOWN,dependencyShorthand:typeof deps==='string',dependencyLine};
  });
  if(group&&candidates.some(c=>!c.stepId)){records.push({...node,planId:node.id});continue;}
  expandedCount+=candidates.length-1;records.push(...candidates);
 }
 const edges=[];const add=(from,to,type)=>{if(from!==to&&!edges.some(e=>e.from===from&&e.to===to))edges.push({from,to,type});};
 for(const node of records){
  for(const dep of node.declaredDependencies)for(const source of records.filter(x=>x.stepId===dep))add(source.id,node.id,'declared');
  for(const edge of base.edges.filter(e=>e.to===node.planId)){
   if(node.declaredDependencies.length&&edge.type==='inferred')continue;
   for(const source of records.filter(x=>x.planId===edge.from))if(!node.group||source.group!==node.group||source.index===node.index)add(source.id,node.id,edge.type);
  }
 }
 // Omit redundant inferred shortcuts so the visible chain remains readable.
 for(let i=edges.length-1;i>=0;i--){const edge=edges[i];if(edge.type!=='inferred')continue;const seen=new Set([edge.from]),queue=[edge.from];while(queue.length){const id=queue.shift();for(const e of edges)if(e!==edge&&e.from===id&&!seen.has(e.to)){seen.add(e.to);queue.push(e.to);}}if(seen.has(edge.to))edges.splice(i,1);}
 for(const node of records)node.dependsOn=edges.filter(e=>e.to===node.id).map(e=>e.from);
 return {...base,version:3,valid:issues.length===0,issues,nodes:records,edges,warnings:base.warnings.filter(w=>w==='dynamicNodes'?records.some(n=>n.dynamic):w==='dynamicDependencies'?records.some(n=>n.dependenciesKnown===false):w==='unresolvedDependencies'?records.some(n=>n.declaredDependencies.some(d=>!records.some(p=>p.stepId===d))):true)};
}
// Attach display provenance without changing the user's spec, hash, approval, or execution order.
export function instrumentWorkflow(script){const {agents}=inspect(script);let result=script;for(const n of agents.sort((a,b)=>b.callee.start-a.callee.start)){const start=n.callee.start-prefix.length,end=n.callee.end-prefix.length;result=result.slice(0,start)+`((__workflowSpec)=>ctx.agent(__workflowSpec,"plan:${n.start-prefix.length}"))`+result.slice(end);}return result;}
