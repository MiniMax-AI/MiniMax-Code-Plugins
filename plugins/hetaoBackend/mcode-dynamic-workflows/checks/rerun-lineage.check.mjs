// Run-lifecycle rerun suite: rerun lineage families. A rerun starts a new
// pending_review run from the source's script+input, never modifies the
// source, and joins a queryable family (rerunOf/lineageRoot/rerunSeq) that
// survives trash and archive rotation. Real store, real engine, real HTTP
// server; every assertion runs against persisted SQLite state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {startHTTP} from '../src/http.mjs';
import {createToolHandler,TOOLS} from '../src/tools.mjs';
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-rerun-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,input={},opts={}){const r=await engine.start({requestId:randomUUID(),name:'Rerun suite',executor:'demo',script,input,...opts});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
async function rerun(engine,id,opts={}){const draft=await engine.rerun(id,opts);await engine.approve(draft.id,{revision:1});return finish(engine,draft.id);}
const headers={'X-Workflow-Client':'1','Content-Type':'application/json'};
const script='const a=await ctx.agent({id:"a",prompt:"a"});return {a:a.output};';
const probe='return await ctx.agent({id:"a",prompt:"a"});';
const rawBody=(store,id)=>store.db.prepare('SELECT body FROM runs WHERE id=?').get(id).body;

test('one rerun leaves the source byte-identical and the child passes the review gate',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const source=await run(f.engine,script);
 assert.equal(source.status,'succeeded');assert.deepEqual(source.result,{a:'a'});
 const before=rawBody(f.store,source.id),beforeSteps=f.store.steps(source.id).map(s=>JSON.stringify(s)),beforeEvents=f.store.events(source.id).map(e=>e.seq);
 // The rerun action only creates a pending_review draft — never auto-executes.
 const draft=await f.engine.rerun(source.id);
 assert.equal(draft.status,'pending_review');assert.notEqual(draft.id,source.id);
 assert.equal(draft.rerunOf,source.id);assert.equal(draft.lineageRoot,source.id);assert.equal(draft.rerunSeq,1);
 assert.equal(draft.requestId,`${source.requestId}#rerun-1`);
 assert.ok(f.store.list().some(r=>r.id===source.id)&&f.store.list().some(r=>r.id===draft.id),'both runs coexist');
 await f.engine.approve(draft.id,{revision:1});
 const child=await finish(f.engine,draft.id);
 assert.equal(child.status,'succeeded');assert.deepEqual(child.result,{a:'a'});
 // The source is untouched down to the stored bytes: no body write, no step
 // write, no event append, and the events chain stays valid.
 assert.equal(rawBody(f.store,source.id),before);
 assert.deepEqual(f.store.steps(source.id).map(s=>JSON.stringify(s)),beforeSteps);
 assert.deepEqual(f.store.events(source.id).map(e=>e.seq),beforeEvents);
 assert.equal(f.store.verifyIntegrity().events.verified,true);
 }finally{await f.cleanup();}
});

test('three reruns grow one ordered family of four with unique requestIds',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const root=await run(f.engine,script,{topic:'original'});
 const c1=await rerun(f.engine,root.id);
 const c2=await rerun(f.engine,c1.id,{input:{topic:'second'}});
 const c3=await rerun(f.engine,root.id);
 assert.equal(c1.rerunOf,root.id);assert.equal(c1.lineageRoot,root.id);assert.equal(c1.rerunSeq,1);
 assert.equal(c2.rerunOf,c1.id);assert.equal(c2.lineageRoot,root.id);assert.equal(c2.rerunSeq,2);
 assert.deepEqual(c2.input,{topic:'second'});assert.deepEqual(root.input,{topic:'original'},'input override touches only the child');
 assert.equal(c3.rerunOf,root.id);assert.equal(c3.rerunSeq,3);
 const family=f.engine.lineage(root.id);
 assert.equal(family.lineageRoot,root.id);
 assert.deepEqual(family.members.map(m=>[m.id,m.rerunSeq]),[[root.id,0],[c1.id,1],[c2.id,2],[c3.id,3]],'root first, members by seq');
 assert.equal(new Set(family.members.map(m=>m.requestId)).size,4,'no requestId ever collides');
 assert.ok(family.members.every(m=>m.status==='succeeded'));
 }finally{await f.cleanup();}
});

test('rerun defaults to real execution; only the explicit flag adopts across runs',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const source=await run(f.engine,probe);
 const fresh=await rerun(f.engine,source.id);
 assert.deepEqual(calls,['a','a'],'the default rerun dispatches a real call');
 assert.equal(fresh.attempts,1);assert.ok(fresh.steps.every(s=>!s.reusedFrom));
 const adopted=await rerun(f.engine,source.id,{reuseAcrossRuns:true});
 assert.deepEqual(calls,['a','a'],'the explicit flag adds no new call');
 assert.equal(adopted.attempts,0);
 const step=adopted.steps.find(s=>s.id==='a');
 assert.equal(step.reusedFrom.runId,fresh.id,'adoption picks the newest succeeded candidate');
 assert.equal(step.reusedFrom.crossRun,true);
 }finally{await f.cleanup();}
});

test('trash and rotation never break the family; only live sources may rerun',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const root=await run(f.engine,script);
 const child=await rerun(f.engine,root.id);
 // Tombstoned members stay in the family, annotated, and cannot rerun.
 await f.engine.deleteRun(child.id,{by:'studio'});
 await assert.rejects(f.engine.rerun(child.id),/回收站/);
 let family=f.engine.lineage(root.id);
 const trashed=family.members.find(m=>m.id===child.id);
 assert.equal(family.members.length,2);
 assert.equal(trashed.deleted.deletedBy,'studio');assert.equal(typeof trashed.deleted.purgeAfter,'number');
 assert.equal(trashed.archived,null);
 // Rotation moves the member into the archive; the family stays complete and
 // the tombstone remains visible on the archived copy (honest history).
 f.engine.configureTrash({trashRetentionDays:0});
 const rotation=f.engine.rotateArchive();
 assert.ok(rotation.rotated);assert.deepEqual(rotation.runs,[child.id]);
 await assert.rejects(f.engine.rerun(child.id),/归档/);
 family=f.engine.lineage(root.id);
 const archivedMember=family.members.find(m=>m.id===child.id);
 assert.equal(archivedMember.archived.rotationId,rotation.rotationId);
 assert.ok(archivedMember.deleted,'the tombstone stays readable on the archived copy');
 // Sequence numbering counts archived members, so the next rerun never
 // reuses a seq (and its synthesized requestId skips the freed slot).
 const next=await f.engine.rerun(root.id);
 assert.equal(next.rerunSeq,2);assert.equal(next.requestId,`${root.requestId}#rerun-2`);
 await f.engine.approve(next.id,{revision:1});await finish(f.engine,next.id);
 // Restoring the archived member brings it back live, unannotated.
 await f.engine.restoreRun(child.id,{by:'cli'});
 family=f.engine.lineage(root.id);
 const restored=family.members.find(m=>m.id===child.id);
 assert.equal(restored.archived,null);assert.equal(restored.deleted,null);assert.equal(restored.status,'succeeded');
 assert.deepEqual(family.members.map(m=>m.rerunSeq),[0,1,2]);
 assert.equal(f.store.verifyIntegrity().events.verified,true,'the events chain stays valid across rerun, trash and rotation');
 }finally{await f.cleanup();}
});

test('a synthesized requestId that collides retries with a numeric suffix',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const draft=await f.engine.start({requestId:'collide-root',name:'Rerun suite',executor:'demo',script:probe,input:{}});
 await f.engine.approve(draft.id,{revision:1});const source=await finish(f.engine,draft.id);
 await f.engine.start({requestId:'collide-root#rerun-1',name:'unrelated',executor:'demo',script:'return 1;',input:{}});
 const child=await f.engine.rerun(source.id);
 assert.equal(child.requestId,'collide-root#rerun-1-2');
 assert.equal(child.rerunSeq,1);
 assert.equal(f.engine.lineage(source.id).members.length,2,'the unrelated claimant is not family');
 }finally{await f.cleanup();}
});

test('HTTP exposes the lineage family face with summaries, trash annotation and opt-in full results',{timeout:10000},async()=>{
 const f=await fixture(async s=>({output:s.id}));const panel=await startHTTP(f.engine);try{
 const origin=new URL(panel.url).origin;
 const root=await run(f.engine,script);
 const child=await rerun(f.engine,root.id);
 await f.engine.deleteRun(child.id,{by:'studio'});
 const missing=await fetch(`${origin}/api/runs/${randomUUID()}/lineage`,{headers});
 assert.equal(missing.status,400);assert.match((await missing.json()).error,/不存在/);
 // Resolvable from any member id — here the tombstoned child.
 const family=await(await fetch(`${origin}/api/runs/${child.id}/lineage`,{headers})).json();
 assert.equal(family.lineageRoot,root.id);
 assert.deepEqual(family.members.map(m=>m.rerunSeq),[0,1]);
 const [r,c]=family.members;
 for(const key of ['id','requestId','name','rerunOf','rerunSeq','status','executor','createdAt','updatedAt','startedAt','finishedAt','durationMs','resultPreview','deleted','archived'])assert.ok(key in r,`member carries ${key}`);
 assert.equal(r.rerunOf,null);assert.equal(r.deleted,null);assert.equal(r.archived,null);
 assert.equal(c.deleted.deletedBy,'studio');assert.equal(c.archived,null);
 assert.ok(r.resultPreview.includes('a'));assert.ok(typeof r.durationMs==='number'&&r.durationMs>=0);
 assert.ok(!('result' in r),'full results are opt-in');
 // ?results=1 feeds the read-only compare face.
 const withResults=await(await fetch(`${origin}/api/runs/${root.id}/lineage?results=1`,{headers})).json();
 assert.deepEqual(withResults.members.find(m=>m.id===root.id).result,{a:'a'});
 assert.deepEqual(withResults.members.find(m=>m.id===child.id).result,{a:'a'});
 }finally{await f.engine.close();await panel.close();await f.cleanup();}
});

test('MCP exposes workflow_rerun with a strict schema, honest errors and no auto-execution',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const handler=createToolHandler(f.engine,()=>'http://127.0.0.1:1/');
 const tool=TOOLS.find(t=>t.name==='workflow_rerun');
 assert.ok(tool,'workflow_rerun missing from TOOLS');
 assert.equal(tool.inputSchema.additionalProperties,false);
 assert.deepEqual(tool.inputSchema.required,['runId']);
 assert.equal(tool.inputSchema.properties.input.type,'object');
 assert.equal(tool.inputSchema.properties.reuseAcrossRuns.type,'boolean');
 assert.equal(typeof tool.inputSchema.properties.reuseAcrossRuns.description,'string');
 const source=await run(f.engine,script);
 const draft=await handler('workflow_rerun',{runId:source.id});
 assert.equal(draft.status,'pending_review');
 assert.equal(draft.rerunOf,source.id);assert.equal(draft.lineageRoot,source.id);assert.equal(draft.rerunSeq,1);
 assert.equal(draft.script,undefined);assert.equal(draft.result,undefined);
 await f.engine.approve(draft.id,{revision:1});
 assert.equal((await finish(f.engine,draft.id)).status,'succeeded');
 await f.engine.deleteRun(source.id);
 await assert.rejects(handler('workflow_rerun',{runId:source.id}),/回收站/);
 await assert.rejects(handler('workflow_rerun',{runId:randomUUID()}),/不存在/);
 await assert.rejects(handler('workflow_rerun',{runId:source.id,reuseAcrossRuns:'yes'}),/布尔/);
 await assert.rejects(handler('workflow_rerun',{runId:source.id,input:[1]}),/input/);
 }finally{await f.cleanup();}
});
