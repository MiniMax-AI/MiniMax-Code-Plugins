// Run-lifecycle archive suite: rotation compaction into the sidecar archive.db,
// manifest verification (including tamper detection), archive restore, startup
// threshold auto-rotation and the CLI maintenance faces. Real store, real
// subprocesses, real exit codes; events-row counts are pinned around every
// rotation because "events never move" is the program red line.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {createToolHandler} from '../src/tools.mjs';
const exec=promisify(execFile),binary=resolve('dist/main.mjs');
const headers={'X-Workflow-Client':'1','Content-Type':'application/json'},DAY=86400000;
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-archive-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,requestId){const r=await engine.start({requestId,name:'Archive suite',executor:'demo',script,input:{}});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const twoSteps='const a=await ctx.agent({id:"a",prompt:"a"});const b=await ctx.agent({id:"b",prompt:"b",dependsOn:["a"]});return {a:a.output,b:b.output};';
// Independent recomputation of the manifest formula: canonical JSON (sorted
// keys, recursive) over [{run:{id,requestId,requestHash,body},steps:[{id,body}]}]
// in (runId, id) order, SHA-256 hex. Deliberately NOT the implementation's
// helper, so a drift between rotation and this check is a failure, not a mirror.
const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==='object')?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
const localManifest=entries=>createHash('sha256').update(JSON.stringify(canon(entries))).digest('hex');
const archiveEntries=archive=>archive.prepare('SELECT runId AS id,requestId,requestHash,body FROM archive_runs ORDER BY runId').all().map(run=>({run,steps:archive.prepare('SELECT id,body FROM archive_steps WHERE runId=? ORDER BY id').all(run.id)}));
const eventCount=store=>Number(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n);

test('rotation exports only due tombstones, keeps every events row, and the manifest verifies independently',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'rotate-1');
 await f.engine.deleteRun(end.id);
 const tombstoned=f.store.get(end.id);
 assert.equal(f.store.rotateDue({now:Date.now()}).rotated,false,'30-day retention: the tombstone is not due yet');
 assert.ok(f.store.get(end.id),'nothing left the library before expiry');
 const eventsBefore=eventCount(f.store),runEventsBefore=f.store.events(end.id).length,stepsBefore=Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM steps WHERE runId=?').get(end.id).n);
 f.engine.configureTrash({trashRetentionDays:0});
 const result=f.store.rotateDue({now:Date.now()});
 assert.equal(result.rotated,true);assert.equal(result.runCount,1);assert.deepEqual(result.runs,[end.id]);
 assert.match(result.manifestHash,/^[0-9a-f]{64}$/);assert.ok(result.bytes>0);
 assert.equal(f.store.get(end.id),null,'runs row physically reclaimed');
 assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM steps WHERE runId=?').get(end.id).n),0,'steps rows physically reclaimed');
 assert.equal(eventCount(f.store),eventsBefore+1,'rotation appends exactly one archive.rotated audit event and removes nothing (red line: events rows never move)');
 assert.equal(f.store.events(end.id).length,runEventsBefore,'the rotated run keeps every one of its own events');
 assert.equal(f.store.listTrash().length,0);
 const integrity=f.store.verifyIntegrity();
 assert.equal(integrity.events.verified,true,'events chain still valid after rotation');
 assert.equal(integrity.archive.verified,true);
 const audit=f.store.events(result.rotationId);
 assert.equal(audit.length,1);assert.equal(audit[0].type,'archive.rotated');
 assert.deepEqual(audit[0].runs,[end.id]);assert.equal(audit[0].manifestHash,result.manifestHash);assert.equal(audit[0].runCount,1);assert.equal(audit[0].bytes,result.bytes);
 const archive=f.store.archive();
 const rotations=archive.prepare('SELECT * FROM rotations').all();
 assert.deepEqual(rotations.map(r=>({rotationId:r.rotationId,manifestHash:r.manifestHash,runCount:r.runCount})),[{rotationId:result.rotationId,manifestHash:result.manifestHash,runCount:1}]);
 const archivedRun=JSON.parse(archive.prepare('SELECT body FROM archive_runs WHERE runId=?').get(end.id).body);
 assert.equal(archivedRun.deletedAt,tombstoned.deletedAt,'the archived body is the tombstoned run verbatim');
 assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM archive_steps').get().n,stepsBefore);
 assert.equal(localManifest(archiveEntries(archive)),result.manifestHash,'independent recomputation matches the rotation manifest');
 assert.equal(localManifest(archiveEntries(archive)),audit[0].manifestHash,'and matches the chained event anchor');
 }finally{await f.cleanup();}
});

test('tampering an archived step, the rotations hash, or deleting a rotation record all fail verification',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'rotate-2');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 const result=f.store.rotateDue({now:Date.now()});
 const archive=f.store.archive();
 assert.equal(f.store.verifyArchive().verified,true);
 const step=archive.prepare('SELECT body FROM archive_steps WHERE id=?').get('a');
 archive.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(step.body),output:'tampered'}),'a');
 assert.equal(f.store.verifyArchive().verified,false);
 assert.equal(f.store.verifyIntegrity().archive.verified,false);
 archive.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(step.body,'a');
 assert.equal(f.store.verifyArchive().verified,true);
 archive.prepare('UPDATE rotations SET manifestHash=?').run('0'.repeat(64));
 assert.equal(f.store.verifyArchive().verified,false,'a forged rotations hash cannot match the chained event');
 archive.prepare('UPDATE rotations SET manifestHash=?').run(result.manifestHash);
 assert.equal(f.store.verifyArchive().verified,true);
 archive.prepare('DELETE FROM rotations').run();
 const missing=f.store.verifyArchive();
 assert.equal(missing.verified,false,'a chained rotation whose archive record vanished fails closed');
 assert.ok(missing.divergences.some(d=>d.includes(result.rotationId)));
 archive.prepare('INSERT INTO rotations VALUES(?,?,?,?,?)').run(result.rotationId,Date.now(),result.manifestHash,1,result.bytes);
 assert.equal(f.store.verifyArchive().verified,true);
 }finally{await f.cleanup();}
});

test('restore refuses tampered archive data fail-closed and passes again once the archive is healed',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'rotate-guard');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 const result=f.store.rotateDue({now:Date.now()});
 const archive=f.store.archive();
 assert.equal(f.store.verifyArchive().verified,true);
 // Tampered archived STEP body: restore must refuse BEFORE any live write.
 const step=archive.prepare('SELECT body FROM archive_steps WHERE id=?').get('a');
 archive.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(step.body),output:'tampered'}),'a');
 const eventsBefore=eventCount(f.store);
 await assert.rejects(()=>f.engine.restoreRun(end.id,{by:'cli'}),error=>{
  assert.ok(error.message.includes(result.rotationId),'the refusal names the failing rotation id');
  assert.ok(error.message.includes(end.id),'the refusal names the refused run');
  assert.match(error.message,/different manifest|chained event|runCount|archive\.rotated/,'the refusal states the verification reason');
  return true;});
 assert.equal(f.store.get(end.id),null,'tampered archive data never becomes a live run row');
 assert.equal(Number(f.store.db.prepare('SELECT COUNT(*) AS n FROM steps WHERE runId=?').get(end.id).n),0,'and never live steps rows');
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.restored').length,0,'no run.restored event was appended');
 assert.equal(eventCount(f.store),eventsBefore,'fail-closed restore writes nothing at all');
 // Heal the archive: the same restore passes again (round-trip).
 archive.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(step.body,'a');
 const restored=await f.engine.restoreRun(end.id,{by:'cli'});
 assert.equal(restored.status,'succeeded');
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.restored').length,1,'the healed restore appends exactly one run.restored');
 // Tampered archived RUN body fails the same way under a fresh rotation.
 await f.engine.deleteRun(restored.id,{by:'cli'});f.engine.configureTrash({trashRetentionDays:0});
 const second=f.store.rotateDue({now:Date.now()});
 const runRow=archive.prepare('SELECT body FROM archive_runs WHERE rotationId=? AND runId=?').get(second.rotationId,end.id);
 archive.prepare('UPDATE archive_runs SET body=? WHERE rotationId=? AND runId=?').run(JSON.stringify({...JSON.parse(runRow.body),name:'tampered'}),second.rotationId,end.id);
 await assert.rejects(()=>f.engine.restoreRun(end.id,{by:'cli'}),error=>error.message.includes(second.rotationId));
 assert.equal(f.store.get(end.id),null,'still no live row from the tampered rotation');
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.restored').length,1,'still exactly the earlier healthy restore event');
 archive.prepare('UPDATE archive_runs SET body=? WHERE rotationId=? AND runId=?').run(runRow.body,second.rotationId,end.id);
 const again=await f.engine.restoreRun(end.id,{by:'cli'});
 assert.equal(again.status,'succeeded');
 assert.equal(f.store.verifyArchive().verified,true,'both healed rotations verify');
 }finally{await f.cleanup();}
});

test('archive restore returns the run live with provenance; re-rotation keeps every old manifest verifiable',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'rotate-3');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 const first=f.store.rotateDue({now:Date.now()});
 assert.throws(()=>f.engine.snapshot(end.id),/不存在/,'rotated run is gone from the live faces');
 const restored=await f.engine.restoreRun(end.id,{by:'cli'});
 assert.equal(restored.status,'succeeded');assert.deepEqual(restored.result,{a:'a',b:'b'});
 assert.equal(restored.steps.length,2);assert.equal(restored.deletedAt,undefined);
 const events=f.store.events(end.id);
 const restoredEvent=events.filter(e=>e.type==='run.restored').at(-1);
 assert.equal(restoredEvent.origin,'archive');assert.equal(restoredEvent.rotationId,first.rotationId);
 assert.equal(f.store.verifyArchive().verified,true,'the archive copy survives restore (copy-back, not move)');
 // Delete and rotate again: a fresh rotation must not disturb the old manifest.
 await f.engine.deleteRun(restored.id);f.engine.configureTrash({trashRetentionDays:0});
 const second=f.store.rotateDue({now:Date.now()});
 assert.notEqual(second.rotationId,first.rotationId);
 const verdict=f.store.verifyArchive();
 assert.equal(verdict.verified,true);assert.equal(verdict.rotations,2);
 assert.ok(verdict.results.every(r=>r.verified));
 // Row-level idempotence: restoring again replaces rows and appends another event.
 const again=await f.engine.restoreRun(end.id,{by:'cli'});
 assert.equal(again.status,'succeeded');
 assert.equal(f.store.events(end.id).filter(e=>e.type==='run.restored').length,2);
 // A newer live run claiming the freed requestId blocks archive restore.
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 const third=f.store.rotateDue({now:Date.now()});
 const claimant=await f.engine.start({requestId:'rotate-3',name:'claimant',executor:'demo',script:'return 1;',input:{}});
 await assert.rejects(f.engine.restoreRun(end.id,{by:'cli'}),/requestId 已被新/);
 // The MCP delete face reports the archive state truthfully for a rotated run.
 const handler=createToolHandler(f.engine,()=>'http://127.0.0.1:1/');
 const archived=await handler('workflow_delete',{runId:end.id});
 assert.equal(archived.deleted,true);assert.equal(archived.alreadyDeleted,true);assert.equal(archived.archived,true);
 assert.equal(archived.rotationId,third.rotationId,'the latest rotation owning the run is reported');
 }finally{await f.cleanup();}
});

async function connect(dir){
 const client=new Client({name:'archive-check',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--workspace',dir,'--data-dir',dir],stderr:'pipe'}));
 return client;
}
const call=async(client,name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);return JSON.parse(result.content[0].text);};
const stop=dir=>exec(process.execPath,[binary,'--stop-service','--workspace',dir,'--data-dir',dir]);

test('service startup auto-rotates oversized expired trash but leaves moderate trash alone',{timeout:90000},async()=>{
 const dirs=[await mkdtemp(join(tmpdir(),'wf-autorot-')),await mkdtemp(join(tmpdir(),'wf-autorot-ctl-'))];
 const seed=async(dir,n)=>{const store=new Store(dir);const now=Date.now();for(let i=0;i<n;i++)store.save({id:`tomb-${i}`,requestId:`req-${i}`,requestHash:`h${i}`,status:'succeeded',name:'tomb',deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});store.close();};
 try{
 await seed(dirs[0],501);await seed(dirs[1],400);
 for(const [dir,expectRotated] of [[dirs[0],true],[dirs[1],false]]){
  const client=await connect(dir);
  try{
   const dashboard=await call(client,'workflow_dashboard');
   assert.equal(existsSync(join(dir,'archive.db')),expectRotated,`${dir} archive presence`);
   const runs=await(await fetch(new URL('/api/runs',dashboard.url),{headers})).json();
   assert.equal(runs.length,0,'no tombstone leaks into the live list');
   const trash=await(await fetch(new URL('/api/runs?trash=1',dashboard.url),{headers})).json();
   assert.equal(trash.length,expectRotated?0:100,'moderate trash stays (listing window caps at 100)');
   const status=await call(client,'workflow_status',{verifyIntegrity:true});
   // verified:null is the #48 "no anchored rows yet" verdict (the seeded
   // control library never wrote an event); only false is a failure.
   assert.notEqual(status.integrity.events.verified,false,'events chain must never fail');
   assert.notEqual(status.integrity.archive.verified,false);
   if(expectRotated){
    assert.equal(status.integrity.events.verified,true,'rotation anchored exactly one archive.rotated event');
    assert.equal(status.integrity.archive.rotations,1);
   }
  }finally{await client.close();await stop(dir);}
 }
 }finally{for(const dir of dirs)await rm(dir,{recursive:true,force:true});}
});

test('CLI rotate/verify/restore run as real subprocesses with honest exit codes and forward to a live service',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-rotate-cli-'));
 const cli=async args=>{try{const {stdout}=await exec(process.execPath,[binary,'--workspace',dir,'--data-dir',dir,...args]);return {ok:true,stdout};}catch(e){return {ok:false,code:e.code,stdout:e.stdout??'',stderr:e.stderr??''};}};
 let runId;
 try{
  {const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
   const end=await run(engine,'return await ctx.agent({id:"a",prompt:"a"});','cli-rotate');
   await engine.deleteRun(end.id,{by:'cli'});await engine.configureTrash({trashRetentionDays:0});
   runId=end.id;await engine.close();store.close();}
  const rotated=await cli(['--rotate-archive']);
  assert.ok(rotated.ok,rotated.stderr);const summary=JSON.parse(rotated.stdout);
  assert.equal(summary.rotated,true);assert.equal(summary.runCount,1);assert.deepEqual(summary.runs,[runId]);
  const good=await cli(['--rotate-archive','--verify']);
  assert.ok(good.ok,good.stderr);
  assert.equal(JSON.parse(good.stdout).archive.verified,true);
  {const adb=new DatabaseSync(join(dir,'archive.db'));
   const body=adb.prepare('SELECT body FROM archive_steps WHERE id=?').get('a').body;
   adb.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(body),output:'tampered'}),'a');adb.close();}
  const bad=await cli(['--rotate-archive','--verify']);
  assert.ok(!bad.ok);assert.equal(bad.code,1);
  assert.equal(JSON.parse(bad.stdout).archive.verified,false,'failure detail stays on stdout with a nonzero exit');
  {const adb=new DatabaseSync(join(dir,'archive.db'));
   const body=adb.prepare('SELECT body FROM archive_steps WHERE id=?').get('a').body;
   adb.prepare('UPDATE archive_steps SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(body),output:'a'}),'a');adb.close();}
  const healed=await cli(['--rotate-archive','--verify']);
  assert.ok(healed.ok,healed.stderr);
  const restored=await cli(['--restore',runId]);
  assert.ok(restored.ok,restored.stderr);
  assert.equal(JSON.parse(restored.stdout).status,'succeeded');
  {const store=new Store(dir);try{assert.equal(store.get(runId).status,'succeeded');}finally{store.close();}}
  // With a live service owning the directory the CLI must forward, not fail
  // on the owner lock (a direct Store open would throw while held).
  const client=await connect(dir);
  try{
   await call(client,'workflow_dashboard');
   const forwarded=await cli(['--rotate-archive']);
   assert.ok(forwarded.ok,forwarded.stderr);
   assert.equal(JSON.parse(forwarded.stdout).rotated,false,'nothing due; forwarded rotation is a clean no-op');
  }finally{await client.close();await stop(dir);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
