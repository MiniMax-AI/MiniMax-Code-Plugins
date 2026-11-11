// Run-lifecycle trash suite: tombstone soft delete, full query-face filtering,
// restore, retention, and the HTTP/MCP exposure. Real store, real engine, real
// HTTP server; every assertion runs against persisted SQLite state.
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
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-trash-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,input={},opts={}){const r=await engine.start({requestId:randomUUID(),name:'Trash suite',executor:'demo',script,input,...opts});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const headers={'X-Workflow-Client':'1','Content-Type':'application/json'};
const script='const a=await ctx.agent({id:"a",prompt:"a"});return {a:a.output};';

test('delete hides the run on every query face; restore brings back steps, events, result and audit verbatim',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,script);
 assert.equal(end.status,'succeeded');assert.deepEqual(end.result,{a:'a'});
 const eventsBefore=f.store.events(end.id).map(e=>e.seq);
 const deleted=await f.engine.deleteRun(end.id,{by:'studio'});
 assert.equal(deleted.deleted,true);assert.equal(deleted.alreadyDeleted,false);
 assert.equal(deleted.purgeAfter,deleted.deletedAt+30*86400000,'default retention stamps purgeAfter=deletedAt+30d');
 // Every read face skips the tombstone; the stored rows themselves never leave.
 assert.ok(!f.store.list().some(r=>r.id===end.id));
 assert.ok(f.store.listTrash().some(r=>r.id===end.id));
 assert.throws(()=>f.engine.snapshot(end.id),/回收站/);
 assert.equal(f.store.step(end.id,'a').status,'succeeded');
 assert.equal(f.store.get(end.id).result.a,'a');
 // Restore: tombstone cleared, everything else untouched, one audit event each.
 const restored=await f.engine.restoreRun(end.id,{by:'studio'});
 assert.equal(restored.id,end.id);assert.equal(restored.status,'succeeded');assert.deepEqual(restored.result,{a:'a'});
 assert.equal(restored.steps[0].id,'a');assert.equal(restored.deletedAt,undefined);
 const events=f.store.events(end.id);
 assert.deepEqual(events.slice(0,eventsBefore.length).map(e=>e.seq),eventsBefore,'earlier events are untouched');
 assert.deepEqual(events.slice(eventsBefore.length).map(e=>e.type),['run.deleted','run.restored'],'audit events append in order');
 assert.equal(events.find(e=>e.type==='run.deleted').by,'studio');
 assert.equal(f.store.verifyIntegrity().events.verified,true,'events chain stays valid across delete and restore');
 assert.ok(f.store.list().some(r=>r.id===end.id));
 assert.ok(!f.store.listTrash().some(r=>r.id===end.id));
 }finally{await f.cleanup();}
});

test('running and pending-review runs refuse deletion; a cancelled run deletes fine',async()=>{
 const f=await fixture(async(s,{signal})=>{await delay(3000,undefined,{signal});return {output:null};});try{
 const draft=await f.engine.start({requestId:randomUUID(),name:'draft',executor:'demo',script:'return 1;',input:{}});
 await assert.rejects(f.engine.deleteRun(draft.id),/仅已完成/);
 const active=await f.engine.start({requestId:randomUUID(),name:'active',executor:'demo',script,input:{}});
 await f.engine.approve(active.id,{revision:1});
 await assert.rejects(f.engine.deleteRun(active.id),/仍在运行/);
 await f.engine.stop(active.id,'cancelled');
 assert.equal(f.engine.snapshot(active.id).status,'cancelled');
 assert.equal((await f.engine.deleteRun(active.id)).deleted,true);
 }finally{await f.cleanup();}
});

test('repeated delete is idempotent and never appends a second audit event',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,script);
 const first=await f.engine.deleteRun(end.id);
 const second=await f.engine.deleteRun(end.id);
 assert.equal(second.deleted,true);assert.equal(second.alreadyDeleted,true);
 assert.equal(second.deletedAt,first.deletedAt);
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.deleted').length,1);
 }finally{await f.cleanup();}
});

// REAL failure injection helper (PR #58 re-review point 3): a SQLite RAISE
// trigger makes the audit-event insert genuinely fail inside the live
// transaction, so the tombstone/restore primitives must roll back whole.
const injectEventFailure=store=>store.db.exec("CREATE TRIGGER inject_event_fail BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected event failure'); END");

test('delete fails closed atomically when the audit event cannot be inserted',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,script);
 const before=f.store.get(end.id),eventsBefore=f.store.events(end.id);
 injectEventFailure(f.store);
 await assert.rejects(f.engine.deleteRun(end.id),/injected event failure/);
 f.store.db.exec('DROP TRIGGER inject_event_fail');
 // Zero state change: no tombstone fields, no audit event, run byte-identical.
 assert.deepEqual(f.store.get(end.id),before,'the run body is exactly as it was');
 assert.deepEqual(f.store.events(end.id),eventsBefore,'no run.deleted event landed');
 assert.ok(f.store.list().some(r=>r.id===end.id));
 assert.ok(!f.store.listTrash().some(r=>r.id===end.id));
 assert.equal(f.store.verifyIntegrity().events.verified,true,'the events chain is untouched by the rollback');
 // Normal path is unaffected once the failure clears.
 assert.equal((await f.engine.deleteRun(end.id)).deleted,true);
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.deleted').length,1);
 }finally{await f.cleanup();}
});

test('restore fails closed atomically when the audit event cannot be inserted',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,script);
 await f.engine.deleteRun(end.id);
 const tombstoned=f.store.get(end.id),eventsAtTombstone=f.store.events(end.id);
 injectEventFailure(f.store);
 await assert.rejects(f.engine.restoreRun(end.id),/injected event failure/);
 f.store.db.exec('DROP TRIGGER inject_event_fail');
 // Zero state change: the tombstone survives intact, no run.restored event.
 assert.deepEqual(f.store.get(end.id),tombstoned,'the tombstone is exactly as it was');
 assert.deepEqual(f.store.events(end.id),eventsAtTombstone,'no run.restored event landed');
 assert.ok(f.store.listTrash().some(r=>r.id===end.id));
 assert.ok(!f.store.list().some(r=>r.id===end.id));
 assert.equal(f.store.verifyIntegrity().events.verified,true);
 // Normal path is unaffected once the failure clears.
 const restored=await f.engine.restoreRun(end.id);
 assert.equal(restored.status,'succeeded');assert.equal(restored.deletedAt,undefined);
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.restored').length,1);
 }finally{await f.cleanup();}
});

test('cross-run reuse never adopts from a tombstoned run and the restored run is a candidate again',async()=>{
 const calls=[],f=await fixture(async s=>{calls.push(s.id);return {output:s.id};});try{
 const probe='return await ctx.agent({id:"a",prompt:"a"});';
 const source=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 await f.engine.deleteRun(source.id);
 const afterDelete=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 assert.deepEqual(calls,['a','a'],'the trashed source was the only candidate; the run must call fresh');
 assert.ok(afterDelete.steps.every(s=>!s.reusedFrom));
 await f.engine.restoreRun(source.id);
 // Tombstone the newer run so the restored source is the only live candidate.
 await f.engine.deleteRun(afterDelete.id);
 const afterRestore=await run(f.engine,probe,{},{reuseAcrossRuns:true});
 assert.equal(afterRestore.steps.find(s=>s.id==='a').reusedFrom.runId,source.id,'restored run serves as a reuse candidate again');
 assert.deepEqual(calls,['a','a']);
 }finally{await f.cleanup();}
});

test('repair, resume and requestId replay all refuse tombstoned runs (no ghost data)',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const broken='const a=await ctx.agent({id:"a",prompt:"a"});throw Error("boom");';
 const failed=await run(f.engine,broken);
 await f.engine.deleteRun(failed.id);
 await assert.rejects(f.engine.repair(failed.id,{requestId:randomUUID(),sourceUpdatedAt:f.store.get(failed.id).updatedAt,script:'return 1;',reason:'fix'}),/回收站/);
 await assert.rejects(f.engine.resume(failed.id),/回收站/);
 await assert.rejects(f.engine.start({requestId:failed.requestId,name:'replay',executor:'demo',script:'return 1;',input:{}}),/回收站/);
 }finally{await f.cleanup();}
});

test('retention is configurable, restamps existing tombstones, and validates its range',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 assert.equal(f.engine.trashRetentionDays(),30,'default retention is 30 days');
 const end=await run(f.engine,script);
 await f.engine.deleteRun(end.id);
 const stamped=f.store.get(end.id);
 assert.equal(stamped.purgeAfter,stamped.deletedAt+30*86400000);
 assert.equal(f.engine.configureTrash({trashRetentionDays:7}).trashRetentionDays,7);
 assert.equal(f.engine.trashRetentionDays(),7);
 assert.equal(f.store.get(end.id).purgeAfter,stamped.deletedAt+7*86400000,'existing tombstones are restamped to the new clock');
 assert.equal(f.engine.configureTrash({trashRetentionDays:0}).trashRetentionDays,0);
 assert.equal(f.store.get(end.id).purgeAfter,stamped.deletedAt,'0 disables expiry: purgeAfter collapses onto deletedAt');
 for(const bad of [-1,1.5,'7',3660,null])await assert.rejects(async()=>f.engine.configureTrash({trashRetentionDays:bad}),/整数/);
 }finally{await f.cleanup();}
});

test('HTTP exposes DELETE, trash listing, restore and retention settings',{timeout:10000},async()=>{
 const f=await fixture(async s=>({output:s.id}));const panel=await startHTTP(f.engine);try{
 const end=await run(f.engine,script);
 const origin=new URL(panel.url).origin;
 const del=await fetch(`${origin}/api/runs/${end.id}`,{method:'DELETE',headers});
 assert.equal(del.status,200);assert.equal((await del.json()).deleted,true);
 const list=await(await fetch(`${origin}/api/runs`,{headers})).json();
 assert.ok(!list.some(r=>r.id===end.id));
 const trash=await(await fetch(`${origin}/api/runs?trash=1`,{headers})).json();
 assert.deepEqual(trash.map(r=>r.id),[end.id]);
 assert.equal(trash[0].script,undefined);assert.equal(trash[0].result,undefined);
 assert.equal(typeof trash[0].deletedAt,'number');assert.equal(typeof trash[0].purgeAfter,'number');
 const detail=await fetch(`${origin}/api/runs/${end.id}`,{headers});
 assert.equal(detail.status,400);assert.match((await detail.json()).error,/回收站/);
 assert.equal((await(await fetch(`${origin}/api/trash`,{headers})).json()).trashRetentionDays,30);
 const saved=await fetch(`${origin}/api/trash`,{method:'POST',headers,body:JSON.stringify({trashRetentionDays:14})});
 assert.equal(saved.status,200);assert.equal((await saved.json()).trashRetentionDays,14);
 const restore=await fetch(`${origin}/api/runs/${end.id}/restore`,{method:'POST',headers,body:JSON.stringify({by:'studio'})});
 assert.equal(restore.status,200);assert.equal((await restore.json()).status,'succeeded');
 assert.ok((await(await fetch(`${origin}/api/runs`,{headers})).json()).some(r=>r.id===end.id));
 }finally{await f.engine.close();await panel.close();await f.cleanup();}
});

test('MCP exposes workflow_delete and workflow_restore with strict schemas and honest errors',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const handler=createToolHandler(f.engine,()=>'http://127.0.0.1:1/');
 for(const name of ['workflow_delete','workflow_restore']){
  const tool=TOOLS.find(t=>t.name===name);
  assert.ok(tool,`${name} missing from TOOLS`);
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.inputSchema.properties.runId.type,'string');
  assert.deepEqual(tool.inputSchema.required,['runId']);
 }
 const end=await run(f.engine,script);
 const deleted=await handler('workflow_delete',{runId:end.id});
 assert.equal(deleted.deleted,true);assert.equal(deleted.alreadyDeleted,false);
 assert.equal((await handler('workflow_delete',{runId:end.id})).alreadyDeleted,true);
 const statusList=await handler('workflow_status',{});
 assert.ok(Array.isArray(statusList));assert.ok(!statusList.some(r=>r.id===end.id));
 await assert.rejects(handler('workflow_status',{runId:end.id}),/回收站/);
 const restored=await handler('workflow_restore',{runId:end.id});
 assert.equal(restored.status,'succeeded');assert.deepEqual(restored.result,{a:'a'});
 await assert.rejects(handler('workflow_restore',{runId:end.id}),/无需恢复/);
 await assert.rejects(handler('workflow_delete',{runId:randomUUID()}),/不存在/);
 await assert.rejects(handler('workflow_delete',{runId:end.id,by:'nonsense'}),/来源/);
 }finally{await f.cleanup();}
});
