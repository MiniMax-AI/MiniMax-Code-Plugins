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
import {Store,ROTATE_BATCH_RUNS,ROTATE_BATCH_BYTES,ROTATE_MAX_BATCHES} from '../src/store.mjs';
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

test('deleting the entire archive sidecar fails closed against the chained rotations; a clean install stays green',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-gone-'));let store=new Store(dir),engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
 try{
 // Clean install: no chain promise plus no sidecar verifies green — it is a
 // verdict about nothing to verify, never a silent skip past the anchor.
 assert.deepEqual(store.verifyArchive(),{exists:false,rotations:0,checked:0,verified:true,results:[],divergences:[]});
 const end=await run(engine,twoSteps,'gone-1');
 await engine.deleteRun(end.id);engine.configureTrash({trashRetentionDays:0});
 assert.equal(store.rotateDue({now:Date.now()}).rotated,true);
 assert.equal(store.verifyArchive().verified,true);
 await engine.close();store.close();
 // Delete the whole sidecar — main database and its WAL siblings — with
 // everything closed, exactly as a whole-archive deletion would look.
 for(const suffix of ['','-wal','-shm'])await rm(join(dir,`archive.db${suffix}`),{force:true});
 store=new Store(dir);engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
 const verdict=store.verifyArchive();
 assert.equal(verdict.exists,false);
 assert.equal(verdict.verified,false,'the live chain still promises the rotation: a missing archive is not an all-clear');
 assert.ok(verdict.divergences.some(d=>d.includes('whole-archive-deleted')),'the divergence names the cause');
 assert.equal(store.verifyIntegrity().archive.verified,false,'verifyIntegrity surfaces the same fail-closed verdict');
 // The rotated run is gone from live faces and cannot be resurrected: with
 // the chain promising an archive that is not there, restore refuses.
 assert.equal(store.get(end.id),null);
 assert.equal(store.restoreArchived(end.id),null);
 }finally{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('rotation is bounded: one call rotates one batch and reports the honest remainder',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-batch-'));const store=new Store(dir);
 try{
  const now=Date.now();
  for(let i=0;i<120;i++)store.save({id:`batch-${String(i).padStart(3,'0')}`,requestId:`breq-${i}`,requestHash:`h${i}`,status:'succeeded',name:'batch',deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});
  const first=store.rotateDue({now:Date.now()});
  assert.equal(first.rotated,true);assert.equal(first.runCount,ROTATE_BATCH_RUNS,'exactly one batch of 50 per call');
  assert.equal(first.remaining,70,'the remainder is reported honestly');
  assert.equal(first.rotations.length,1);assert.match(first.rotationId,/^[0-9a-f-]{36}$/);assert.match(first.manifestHash,/^[0-9a-f]{64}$/);
  assert.deepEqual(first.runs.map(id=>id.slice(-3)),Array.from({length:50},(_,i)=>String(i).padStart(3,'0')),'the id-ordered cursor takes the first 50');
  const second=store.rotateDue({now:Date.now()});
  assert.equal(second.runCount,50);assert.equal(second.remaining,20);
  assert.notEqual(second.rotationId,first.rotationId,'each batch is its own rotation');
  const third=store.rotateDue({now:Date.now()});
  assert.equal(third.runCount,20);assert.equal(third.remaining,0);
  assert.equal(store.tombstoneCount(),0,'nothing due is left behind');
  const verdict=store.verifyIntegrity();
  assert.equal(verdict.archive.verified,true);assert.equal(verdict.archive.rotations,3);
  assert.equal(verdict.events.verified,true,'three chained archive.rotated events anchor the three batches');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('the per-batch byte budget splits oversized rotations; a single oversized run still rotates alone',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-batchbytes-'));const store=new Store(dir);
 try{
  const now=Date.now(),big='x'.repeat(1024*1024);
  for(let i=0;i<30;i++)store.save({id:`big-${String(i).padStart(3,'0')}`,requestId:`zreq-${i}`,requestHash:`h${i}`,status:'succeeded',name:'big',big,deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});
  const first=store.rotateDue({now:Date.now()});
  assert.equal(first.rotated,true);
  assert.ok(first.runCount>=4&&first.runCount<30,`the byte budget cuts the batch short (${first.runCount} of 30)`);
  assert.equal(first.remaining,30-first.runCount);
  // Drain the rest one bounded call at a time; every rotation stays within
  // the budget and the totals reconcile exactly.
  let total=first.runCount,calls=1;
  while(total<30){
   const next=store.rotateDue({now:Date.now()});
   assert.ok(next.rotated);assert.ok(next.rotations.every(r=>r.bytes<=ROTATE_BATCH_BYTES),'no batch exceeds the byte budget');
   total+=next.runCount;calls++;
   assert.ok(calls<=12,'the drain must converge');
  }
  assert.equal(total,30);assert.equal(store.rotateDue({now:Date.now()}).remaining,0);
  // A single tombstone larger than the whole budget still rotates — alone.
  store.save({id:'huge',requestId:'zreq-huge',requestHash:'huge',status:'succeeded',name:'huge',big:'y'.repeat(ROTATE_BATCH_BYTES+65536),deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});
  const huge=store.rotateDue({now:Date.now()});
  assert.equal(huge.runCount,1);assert.deepEqual(huge.runs,['huge']);assert.ok(huge.bytes>ROTATE_BATCH_BYTES);
  const verdict=store.verifyIntegrity();
  assert.equal(verdict.archive.verified,true);
  assert.equal(verdict.events.verified,true);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('startup auto-rotation is bounded to one batch; the backlog drains in the background',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-startbatch-'));const store=new Store(dir);const engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
 try{
  const now=Date.now();
  for(let i=0;i<501;i++)store.save({id:`sb-${String(i).padStart(3,'0')}`,requestId:`sreq-${i}`,requestHash:`h${i}`,status:'succeeded',name:'sb',deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});
  const compaction=engine.autoRotateAtStartup();
  assert.equal(compaction.autoRotated,true);
  assert.equal(compaction.runCount,ROTATE_BATCH_RUNS,'the synchronous startup pass rotates exactly one batch');
  assert.equal(compaction.remaining,451,'the rest of the backlog is reported, not silently rotated before serving');
  assert.equal(store.verifyIntegrity().archive.verified,true);
  // The background drain empties the trash one throttled batch at a time.
  engine.drainRotationsInBackground({intervalMs:1});
  for(let i=0;i<600&&store.tombstoneCount()>0;i++)await delay(10);
  assert.equal(store.tombstoneCount(),0,'the drain completes');
  const verdict=store.verifyIntegrity();
  assert.equal(verdict.archive.rotations,Math.ceil(501/ROTATE_BATCH_RUNS),'501 tombstones rotate in 11 bounded batches');
  assert.equal(verdict.archive.verified,true);
  assert.equal(verdict.events.verified,true);
 }finally{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('the manual rotate face chains bounded batches per call',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-batchface-'));const store=new Store(dir);const engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
 try{
  const now=Date.now();
  for(let i=0;i<130;i++)store.save({id:`bf-${String(i).padStart(3,'0')}`,requestId:`freq-${i}`,requestHash:`h${i}`,status:'succeeded',name:'bf',deletedAt:now-40*DAY,purgeAfter:now-10*DAY,deletedBy:'cli'});
  const capped=engine.rotateArchive({batches:2});
  assert.equal(capped.runCount,100,'an explicit two-batch request rotates exactly two batches');
  assert.equal(capped.remaining,30);
  assert.equal(capped.rotationId,null);assert.equal(capped.manifestHash,null,'multi-batch results carry their hashes per rotation, not flat');
  assert.equal(capped.rotations.length,2);assert.ok(capped.rotations.every(r=>r.manifestHash&&r.rotationId));
  const rest=engine.rotateArchive({});
  assert.equal(rest.runCount,30);assert.equal(rest.remaining,0);
  assert.equal(rest.rotationId,rest.rotations[0].rotationId,'the final single-batch call keeps the flat shape');
  const verdict=store.verifyIntegrity();
  assert.equal(verdict.archive.verified,true);assert.equal(verdict.events.verified,true);
  for(const bad of [0,-1,1.5,'3',ROTATE_MAX_BATCHES+1])await assert.rejects(async()=>engine.rotateArchive({batches:bad}),/批数/);
 }finally{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
});

async function connect(dir){
 const client=new Client({name:'archive-check',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--workspace',dir,'--data-dir',dir],stderr:'pipe'}));
 return client;
}
const call=async(client,name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);return JSON.parse(result.content[0].text);};
const stop=dir=>exec(process.execPath,[binary,'--stop-service','--workspace',dir,'--data-dir',dir]);

test('service startup auto-rotates oversized expired trash in bounded batches; moderate trash stays',{timeout:90000},async()=>{
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
   // The service was already serving after ONE bounded batch; the backlog
   // drains in the background — poll until the oversized trash is empty.
   let trash;
   for(let i=0;i<160;i++){
    trash=await(await fetch(new URL('/api/runs?trash=1',dashboard.url),{headers})).json();
    if(!expectRotated||trash.length===0)break;
    await delay(500);
   }
   if(expectRotated)assert.equal(trash.length,0,'the background drain empties the oversized expired trash');
   else assert.equal(trash.length,100,'moderate trash stays (listing window caps at 100)');
   const status=await call(client,'workflow_status',{verifyIntegrity:true});
   // verified:null is the #48 "no anchored rows yet" verdict (the seeded
   // control library never wrote an event); only false is a failure.
   assert.notEqual(status.integrity.events.verified,false,'events chain must never fail');
   assert.notEqual(status.integrity.archive.verified,false);
   if(expectRotated){
    assert.equal(status.integrity.events.verified,true,'every drained batch anchored exactly one archive.rotated event');
    assert.equal(status.integrity.archive.rotations,Math.ceil(501/ROTATE_BATCH_RUNS),'501 tombstones rotate in 11 bounded batches');
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
