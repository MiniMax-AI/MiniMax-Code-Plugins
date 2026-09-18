import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {TOOLS} from '../src/tools.mjs';
// SDD contract suite for run-level reuseAcrossRuns (cross-run reuse of succeeded
// agent nodes). The engine/store behavior specified here may not exist yet; this
// file is the contract the implementation must satisfy.
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-xreuse-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,input={},opts={}){const r=await engine.start({requestId:crypto.randomUUID(),name:'Cross reuse',executor:'demo',script,input,...opts});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const probe=`return await ctx.agent({id:'a',prompt:'a'});`;
const chain=`const a=await ctx.agent({id:'a',prompt:'a'});const b=await ctx.agent({id:'b',prompt:'b',dependsOn:['a']});`;
const broken=chain+`throw Error('bad synthesis');`;
const repaired=chain+`return {a:a.output,b:b.output};`;
test('cross-run reuse is opt-in; without the flag a second identical run makes fresh calls and reuses nothing',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const first=await run(f.engine,probe),second=await run(f.engine,probe);
 assert.equal(first.status,'succeeded');assert.equal(second.status,'succeeded');
 assert.deepEqual(calls,['a','a']);assert.ok(second.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('an opted-in run adopts the newest succeeded node from an identical context without a new model call',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const source=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const end=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const step=end.steps.find(s=>s.id==='a');
 assert.equal(end.status,'succeeded');assert.equal(end.attempts,0);assert.deepEqual(calls,['a']);
 assert.equal(step.attempt,0);assert.equal(step.usage,null);assert.deepEqual(step.usageHistory,[]);
 assert.equal(step.reusedFrom.runId,source.id);assert.equal(step.reusedFrom.stepId,'a');assert.equal(step.reusedFrom.crossRun,true);assert.equal(typeof step.reusedFrom.endedAt,'number');
 assert.ok(f.store.events(end.id).some(e=>e.type==='step.reused'&&e.stepId==='a'));
 }finally{await f.cleanup();}
});
test('a changed input hashes to a different context so the opted-in run calls again',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const end=await run(f.engine,probe,{tenant:'other'},{reuseAcrossRuns:true});
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','a']);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('a changed executor hashes to a different context so the opted-in run cannot reuse; the fresh call is observable',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await run(f.engine,probe,{},{reuseAcrossRuns:true,executor:'demo'});
 const end=await run(f.engine,probe,{},{reuseAcrossRuns:true,executor:'mcode'});
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','a']);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('a changed prompt misses cross-run reuse even in an otherwise identical context',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const end=await run(f.engine,probe.replace("prompt:'a'","prompt:'changed'"),{},{reuseAcrossRuns:true});
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','a']);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('adding an output schema changes the node request hash so cross-run reuse misses',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const end=await run(f.engine,`return await ctx.agent({id:'a',prompt:'a',schema:{type:'string'}});`,{},{reuseAcrossRuns:true});
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','a']);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('only succeeded nodes are cross-run candidates; a failed source node is called again',async()=>{
 let fail=true;const calls=[],f=await fixture(async s=>{calls.push(s.id);if(s.id==='b'&&fail)throw Error('provider failure');return {output:s.id};});try{
 const source=await run(f.engine,broken,{},{reuseAcrossRuns:true});
 assert.equal(source.status,'failed');fail=false;
 const end=await run(f.engine,repaired,{},{reuseAcrossRuns:true});
 assert.equal(end.status,'succeeded');assert.deepEqual(end.result,{a:'a',b:'b'});assert.deepEqual(calls,['a','b','b']);
 assert.equal(end.steps.find(s=>s.id==='a').reusedFrom.runId,source.id);assert.equal(end.steps.find(s=>s.id==='b').reusedFrom,undefined);assert.equal(end.attempts,1);
 }finally{await f.cleanup();}
});
test('with several qualifying runs the newest succeeded run wins',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const ids=[];for(let i=0;i<3;i++){const r=await run(f.engine,probe);assert.ok(r.steps.every(s=>!s.reusedFrom));ids.push(r.id);}
 assert.deepEqual(calls,['a','a','a']);
 const end=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const step=end.steps.find(s=>s.id==='a');
 assert.equal(end.status,'succeeded');assert.equal(end.attempts,0);assert.deepEqual(calls,['a','a','a']);
 assert.equal(step.reusedFrom.runId,ids[2]);assert.equal(step.reusedFrom.crossRun,true);
 }finally{await f.cleanup();}
});
test('pure cross-run reuse succeeds on a one-call budget without consuming it',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await run(f.engine,probe,{},{reuseAcrossRuns:true});
 const end=await run(f.engine,probe,{},{reuseAcrossRuns:true,maxCalls:1});
 assert.equal(end.status,'succeeded');assert.equal(end.attempts,0);assert.deepEqual(calls,['a']);
 }finally{await f.cleanup();}
});
test('tracked-file changes between approvals change fingerprints and the context hash so reuse misses',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 await writeFile(join(f.dir,'evidence.txt'),'X');
 await run(f.engine,probe,{files:['evidence.txt']},{reuseAcrossRuns:true});
 await writeFile(join(f.dir,'evidence.txt'),'Y');
 const end=await run(f.engine,probe,{files:['evidence.txt']},{reuseAcrossRuns:true});
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','a']);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('reusing a requestId with a flipped reuseAcrossRuns value is rejected as a parameter conflict',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const requestId=crypto.randomUUID();
 await f.engine.start({requestId,name:'Cross reuse',executor:'demo',script:probe,input:{}});
 await assert.rejects(f.engine.start({requestId,name:'Cross reuse',executor:'demo',script:probe,input:{},reuseAcrossRuns:true}),/requestId 已用于不同参数/);
 }finally{await f.cleanup();}
});
test('a changed upstream prompt invalidates the downstream candidate even though its own spec is unchanged',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.prompt};});try{
 const first=await run(f.engine,repaired,{},{reuseAcrossRuns:true});
 assert.equal(first.status,'succeeded');assert.deepEqual(first.result,{a:'a',b:'b'});assert.deepEqual(calls,['a','b']);
 const second=await run(f.engine,repaired.replace("prompt:'a'","prompt:'new'"),{},{reuseAcrossRuns:true});
 assert.equal(second.status,'succeeded');
 assert.deepEqual(calls,['a','b','a','b']);
 assert.deepEqual(second.result,{a:'new',b:'b'});
 assert.ok(second.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('mcode nodes without an explicit model are never cross-run candidates; with an explicit model they are',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.model??'default'};});try{
 const opts={reuseAcrossRuns:true,executor:'mcode'};
 const withModel=`return await ctx.agent({id:'a',prompt:'a',model:'m2'});`;
 const r1=await run(f.engine,withModel,{},opts),r2=await run(f.engine,withModel,{},opts);
 assert.equal(r1.status,'succeeded');assert.equal(r2.status,'succeeded');
 assert.deepEqual(calls,['a']);assert.equal(r2.attempts,0);
 assert.equal(r2.steps.find(s=>s.id==='a').reusedFrom.crossRun,true);
 const r3=await run(f.engine,probe,{},opts),r4=await run(f.engine,probe,{},opts);
 assert.equal(r3.status,'succeeded');assert.equal(r4.status,'succeeded');
 assert.equal(r3.attempts,1);assert.equal(r4.attempts,1);assert.deepEqual(calls,['a','a','a']);
 assert.ok([...r3.steps,...r4.steps].every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('workflow_start and workflow_update expose reuseAcrossRuns as a boolean parameter',()=>{
 for(const name of ['workflow_start','workflow_update']){
  const tool=TOOLS.find(t=>t.name===name);
  assert.ok(tool,`${name} missing from TOOLS`);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.inputSchema.properties.reuseAcrossRuns.type,'boolean');
  assert.equal(typeof tool.inputSchema.properties.reuseAcrossRuns.description,'string');
 }
});
test('chained adoption keeps reusedFrom on the immediate source and originalProducer on the first producer',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const run1=await run(f.engine,repaired,{},{reuseAcrossRuns:true});
 const run2=await run(f.engine,repaired,{},{reuseAcrossRuns:true});
 const run3=await run(f.engine,repaired,{},{reuseAcrossRuns:true});
 assert.deepEqual(calls,['a','b']);assert.equal(run3.attempts,0);
 const b1=run1.steps.find(s=>s.id==='b'),b2=run2.steps.find(s=>s.id==='b'),b3=run3.steps.find(s=>s.id==='b');
 assert.equal(b2.reusedFrom.runId,run1.id);assert.equal(b2.reusedFrom.crossRun,true);
 assert.equal(b2.originalProducer.runId,run1.id);assert.equal(b2.originalProducer.stepId,'b');
 assert.equal(b3.reusedFrom.runId,run2.id);assert.equal(b3.reusedFrom.stepId,'b');assert.equal(b3.reusedFrom.crossRun,true);
 assert.equal(b3.originalProducer.runId,run1.id);assert.equal(b3.originalProducer.stepId,'b');
 assert.equal(b3.usage,null);assert.deepEqual(b3.usageHistory,[]);
 }finally{await f.cleanup();}
});
test('an upstream that re-executes with a different output invalidates downstream adoption',async()=>{
 // Maintainer's divergence shape: the upstream is not a cross-run candidate itself
 // (mcode node without an explicit model re-executes every run) and its output
 // differs between runs; the eligible downstream must not adopt the stale result.
 let aOutput='old';const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id==='a'?aOutput:s.id};});try{
 const script=`const a=await ctx.agent({id:'a',prompt:'write'});const b=await ctx.agent({id:'b',prompt:'read',model:'m2',dependsOn:['a'],input:{content:a.output}});return {a:a.output,b:b.output};`;
 const run1=await run(f.engine,script,{},{executor:'mcode'});
 aOutput='new';
 const run2=await run(f.engine,script,{},{executor:'mcode',reuseAcrossRuns:true});
 assert.deepEqual(calls,['a','b','a','b'],'a re-executes (no model => never a candidate); b must not adopt the stale run-1 result');
 assert.deepEqual(run2.result,{a:'new',b:'b'});
 assert.ok(!run2.steps.find(s=>s.id==='b').reusedFrom,'divergent upstream output must break lineage');
 }finally{await f.cleanup();}
});
