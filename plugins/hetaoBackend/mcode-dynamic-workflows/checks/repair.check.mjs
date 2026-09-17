import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {startHTTP} from '../src/http.mjs';
import {createToolHandler} from '../src/tools.mjs';
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-repair-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function start(engine,script,input={}){const r=await engine.start({requestId:crypto.randomUUID(),name:'Repair',executor:'demo',script,input});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const prefix=`const a=await ctx.agent({id:'a',prompt:'a'});const b=await ctx.agent({id:'b',prompt:'b',dependsOn:['a']});`;
const broken=prefix+`throw Error('bad synthesis');`;
const repaired=prefix+`return {a:a.output,b:b.output};`;
function request(source,extra={}){return {requestId:crypto.randomUUID(),sourceUpdatedAt:source.updatedAt,script:repaired,reason:'Fix final synthesis',reuseStepIds:['a','b'],...extra};}
test('repair is a distinct reviewed draft; matching successes reuse without new calls or double-counting usage',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id,usage:{totalTokens:50}};});try{
 const source=await start(f.engine,broken),original=f.store.get(source.id),req=request(source),draft=await f.engine.repair(source.id,req);
 assert.equal(source.status,'failed');assert.equal(draft.status,'pending_review');assert.notEqual(draft.id,source.id);assert.equal(draft.steps.length,0);assert.equal(draft.attempts,0);assert.deepEqual(calls,['a','b']);assert.equal((await f.engine.repair(source.id,req)).id,draft.id);
 await assert.rejects(f.engine.repair(source.id,{...req,reason:'different'}),/requestId/);
 await assert.rejects(f.engine.approve(draft.id,{revision:2}),/审核版本/);
 await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');assert.deepEqual(end.result,{a:'a',b:'b'});assert.deepEqual(calls,['a','b']);assert.equal(end.attempts,0);assert.ok(end.steps.every(s=>s.reusedFrom.runId===source.id&&s.usage===null&&s.usageHistory.length===0));assert.deepEqual(f.store.get(source.id),original);
 }finally{await f.cleanup();}
});
test('changed upstream parameters transitively invalidate selected downstream nodes',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:'same output'};});try{
 const source=await start(f.engine,broken),draft=await f.engine.repair(source.id,request(source,{script:repaired.replace("prompt:'a'","prompt:'fixed a'")}));await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');assert.deepEqual(calls,['a','b','a','b']);assert.equal(end.attempts,2);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});
test('reuse is opt-in; deselecting an upstream forces selected descendants to rerun',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const source=await start(f.engine,broken);for(const reuseStepIds of [undefined,['b']]){const draft=await f.engine.repair(source.id,request(source,{reuseStepIds}));await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);assert.equal(end.attempts,2);}
 assert.deepEqual(calls,['a','b','a','b','a','b']);
 }finally{await f.cleanup();}
});
test('draft edits, input changes, executor changes and tracked-file changes cannot silently reuse old results',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 await writeFile(join(f.dir,'input.txt'),'original');const source=await start(f.engine,broken,{files:['input.txt']});
 for(const change of [{input:{files:['input.txt'],extra:true}},{executor:'mcode'},{script:repaired.replace("prompt:'a'","prompt:'changed'")}]){const draft=await f.engine.repair(source.id,request(source));await f.engine.update(draft.id,{revision:1,...change});await f.engine.approve(draft.id,{revision:2});const end=await finish(f.engine,draft.id);assert.equal(end.attempts,2);}
 const draft=await f.engine.repair(source.id,request(source));await writeFile(join(f.dir,'input.txt'),'changed after repair');await f.engine.approve(draft.id,{revision:1});assert.equal((await finish(f.engine,draft.id)).attempts,2);
 }finally{await f.cleanup();}
});
test('frozen candidates survive database reopen and source changes; unreachable nodes are not materialized',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const source=await start(f.engine,broken),draft=await f.engine.repair(source.id,request(source,{script:`return (await ctx.agent({id:'a',prompt:'a'})).output;`}));
 const a=f.store.step(source.id,'a');a.output='later changed';f.store.saveStep(source.id,a);f.store.close();f.store=new Store(f.dir);f.engine.store=f.store;
 await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);assert.equal(end.result,'a');assert.deepEqual(end.steps.map(s=>s.id),['a']);assert.equal(end.attempts,0);
 }finally{await f.engine.close();f.store.close();await rm(f.dir,{recursive:true,force:true});}
});
test('failed and invalid legacy outputs are never reused, changed schemas rerun producer',async()=>{
 let fail=true;const f=await fixture(async s=>{if(s.id==='b'&&fail)throw Error('provider failure');return {output:'not an object'};});try{
 const source=await start(f.engine,prefix+'return b;');await assert.rejects(f.engine.repair(source.id,request(source)),/b.*不是/);
 const draft=await f.engine.repair(source.id,request(source,{reuseStepIds:['a'],script:`return await ctx.agent({id:'a',prompt:'a',schema:{type:'object'}});`}));await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);assert.equal(end.attempts,1);assert.equal(end.steps[0].errorDetails.code,'OUTPUT_SCHEMA_INVALID');
 }finally{await f.cleanup();}
});
test('reject stale, active and unconfirmed crash sources without creating a draft',async()=>{
 const f=await fixture(async()=>({output:null}));try{
 const source=await start(f.engine,broken);await assert.rejects(f.engine.repair(source.id,request(source,{sourceUpdatedAt:0})),/源运行已更新/);
 for(const status of ['running','needs_attention','pending_review']){f.store.save({...source,status});await assert.rejects(f.engine.repair(source.id,request(source)),/请先停止/);}
 assert.equal(f.store.list().length,1);
 }finally{await f.cleanup();}
});
test('HTTP repair and MCP definition retrieval expose the review flow, never automatic approval',async()=>{
 const f=await fixture(async s=>({output:s.id})),http=await startHTTP(f.engine);try{
 const source=await start(f.engine,broken),handler=createToolHandler(f.engine,()=>http.url),info=await handler('workflow_results',{runId:source.id,includeDefinition:true});assert.equal(info.definition.script,broken);assert.equal(info.updatedAt,source.updatedAt);
 const result=await fetch(new URL(`/api/runs/${source.id}/repair`,http.url),{method:'POST',headers:{'X-Workflow-Client':'1','Content-Type':'application/json'},body:JSON.stringify(request(source))});assert.equal(result.status,200);const draft=await result.json();assert.equal(draft.status,'pending_review');assert.equal(f.engine.active.size,0);
 const toolDraft=await handler('workflow_repair',{runId:source.id,...request(source)});assert.equal(toolDraft.status,'pending_review');assert.equal(toolDraft.script,undefined);
 }finally{await http.close();await f.cleanup();}
});
test('independent successful branches remain reusable while changed branches and checkpoints recompute',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const sourceScript=`const independent=await ctx.agent({id:'independent',prompt:'stable'});${prefix}await ctx.checkpoint('summary','old');throw Error('synthesis');`;
 const source=await start(f.engine,sourceScript),script=sourceScript.replace("prompt:'a'","prompt:'new'").replace("'old'","'new'").replace("throw Error('synthesis');","return await ctx.checkpoint('summary','new');");
 const draft=await f.engine.repair(source.id,request(source,{script,reuseStepIds:['independent','a','b']}));await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');assert.equal(end.result,'new');assert.equal(end.attempts,2);assert.deepEqual(calls,['independent','a','b','a','b']);assert.equal(end.steps.find(s=>s.id==='independent').reusedFrom.runId,source.id);assert.equal(f.store.step(source.id,'checkpoint:summary').output,'old');
 }finally{await f.cleanup();}
});
test('reviewers can deselect frozen results before approval; edits cannot add unreviewed cache entries',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const source=await start(f.engine,broken),draft=await f.engine.repair(source.id,request(source));
 await assert.rejects(f.engine.update(draft.id,{revision:1,reuseStepIds:['unknown']}),/候选节点/);
 await f.engine.update(draft.id,{revision:1,reuseStepIds:['b'],reason:'The upstream result is stale'});
 await f.engine.approve(draft.id,{revision:2});const end=await finish(f.engine,draft.id);assert.equal(end.attempts,2);assert.equal(end.repair.reason,'The upstream result is stale');assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});

test('binary file changes invalidate reuse even when UTF-8 decoding is identical',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const before=Buffer.from([0x80]),after=Buffer.from([0x81]);assert.equal(before.toString(),after.toString());
 await writeFile(join(f.dir,'evidence.bin'),before);
 const source=await start(f.engine,broken,{files:['evidence.bin']});
 const draft=await f.engine.repair(source.id,request(source));
 await writeFile(join(f.dir,'evidence.bin'),after);
 await assert.rejects(f.engine.resume(source.id),/源文件已改变/);
 await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');assert.equal(end.attempts,2);assert.ok(end.steps.every(s=>!s.reusedFrom));
 }finally{await f.cleanup();}
});

test('fingerprints retain special filenames and reject nonregular or oversized files',async()=>{
 const f=await fixture(async()=>({output:null}));try{
 for(const name of ['__proto__','..notes'])await writeFile(join(f.dir,name),'first');
 const before=await f.engine.fingerprints(['__proto__','..notes']);
 assert.equal(Object.hasOwn(before,'__proto__'),true);assert.equal(Object.hasOwn(before,'..notes'),true);
 await writeFile(join(f.dir,'__proto__'),'second');
 assert.notEqual((await f.engine.fingerprints(['__proto__'])).__proto__,before.__proto__);
 await writeFile(join(f.dir,'large.bin'),Buffer.alloc(1_000_001));
 await assert.rejects(f.engine.fingerprints(['large.bin']),/1MB/);
 await mkdir(join(f.dir,'folder'));await assert.rejects(f.engine.fingerprints(['folder']),/普通文件|EISDIR/);
 await assert.rejects(f.engine.fingerprints(['.']),/文件超出工作区/);
 }finally{await f.cleanup();}
});

test('node schemas are independent even when their local identifiers repeat across nodes and runs',async()=>{
 const f=await fixture(async s=>({output:s.id==='boolean'?true:'text'}));try{
 const schema=type=>({$id:'urn:workflow:result',$defs:{value:{type}},$ref:'#/$defs/value'});
 const script=`return await Promise.all([ctx.agent({id:'boolean',prompt:'p',schema:${JSON.stringify(schema('boolean'))}}),ctx.agent({id:'text',prompt:'p',schema:${JSON.stringify(schema('string'))}})]);`;
 for(let i=0;i<2;i++){
  const run=await start(f.engine,script);assert.equal(run.status,'succeeded',run.error);
  assert.deepEqual(run.steps.map(s=>s.output),[true,'text']);
 }
 }finally{await f.cleanup();}
});

test('the false JSON Schema cannot silently accept a node output',async()=>{
 const f=await fixture(async()=>({output:{unexpected:true}}));try{
 const run=await start(f.engine,`return await ctx.agent({id:'never-valid',prompt:'p',schema:false});`);
 assert.equal(run.status,'completed_with_gaps');assert.equal(run.steps[0].status,'failed');
 assert.equal(run.steps[0].errorDetails.code,'OUTPUT_SCHEMA_INVALID');assert.deepEqual(run.steps[0].rawOutput,{unexpected:true});
 }finally{await f.cleanup();}
});

test('checkpoint dependencies with unchanged values keep candidates reusable; changed values invalidate downstream',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const sourceScript=`await ctx.checkpoint('seed','v1');const a=await ctx.agent({id:'a',prompt:'a',dependsOn:'checkpoint:seed'});throw Error('bad synthesis');`;
 const source=await start(f.engine,sourceScript);
 const draft=await f.engine.repair(source.id,request(source,{script:sourceScript.replace("throw Error('bad synthesis');",'return a.output;'),reuseStepIds:['a']}));
 await f.engine.approve(draft.id,{revision:1});const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');assert.equal(end.attempts,0);assert.equal(end.steps.find(s=>s.id==='a').reusedFrom.runId,source.id);
 const changed=await f.engine.repair(source.id,request(source,{script:sourceScript.replace("'v1'","'v2'").replace("throw Error('bad synthesis');",'return a.output;'),reuseStepIds:['a']}));
 await f.engine.approve(changed.id,{revision:1});const done=await finish(f.engine,changed.id);
 assert.equal(done.status,'succeeded');assert.equal(done.attempts,1);assert.ok(!done.steps.find(s=>s.id==='a').reusedFrom);assert.deepEqual(calls,['a','a']);
 }finally{await f.cleanup();}
});
