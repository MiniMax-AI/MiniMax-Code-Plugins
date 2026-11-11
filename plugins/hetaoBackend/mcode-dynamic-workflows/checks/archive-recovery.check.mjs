// Cross-database crash recovery suite (PR #58 re-review point 2). Rotation
// commits the archive side first and the live side second; no transaction can
// span both files, so the crash window between the two commits must leave a
// state that fails verification visibly, loses nothing, and is repaired
// deterministically. Failures are injected for real — an SQLite RAISE(ABORT)
// lands inside the live transaction after the archive commit, and a child
// process is SIGKILLed through the production seam exactly between the two
// commits — never mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
const exec=promisify(execFile),DAY=86400000;
// The crash child imports the source Store via `node --input-type=module -e`.
// The import specifier MUST be a file:// URL: a bare absolute Windows path
// ("D:\\...\\store.mjs") dies at module load with ERR_UNSUPPORTED_ESM_URL_SCHEME
// (the drive letter parses as protocol 'd:') before any injection logic runs —
// fork preview runs 35696536334 and its predecessor both failed on this, with
// the true stderr hidden behind "Command failed". pathToFileURL().href is the
// portable spelling and is equally legal on POSIX.
const storeURL=pathToFileURL(fileURLToPath(new URL('../src/store.mjs',import.meta.url))).href;
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-recover-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function run(engine,script,requestId){const r=await engine.start({requestId,name:'Recovery suite',executor:'demo',script,input:{}});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const twoSteps='const a=await ctx.agent({id:"a",prompt:"a"});const b=await ctx.agent({id:"b",prompt:"b",dependsOn:["a"]});return {a:a.output,b:b.output};';
const chainedCount=store=>Number(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(body,'$.type')='archive.rotated'").get().n);

test('a live-transaction abort after the archive commit leaves a reconcilable orphan, not corruption',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const end=await run(f.engine,twoSteps,'recover-1');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 // REAL failure injection: the archive.rotated insert aborts at the SQLite
 // level while the archive side has already committed — the exact durable
 // state of a crash in the un-transactionable gap between the two commits.
 f.store.db.exec("CREATE TRIGGER inject_rotated_fail BEFORE INSERT ON events WHEN json_extract(new.body,'$.type')='archive.rotated' BEGIN SELECT RAISE(ABORT,'injected live-transaction failure'); END");
 await assert.rejects(async()=>f.store.rotateDue({now:Date.now()}),/injected live-transaction failure/);
 f.store.db.exec('DROP TRIGGER inject_rotated_fail');
 const archive=f.store.archive();
 assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1,'the archive side committed before the abort');
 assert.ok(f.store.get(end.id),'the live rows never left: the live transaction rolled back whole');
 assert.equal(chainedCount(f.store),0,'no archive.rotated event landed');
 assert.equal(f.store.verifyIntegrity().archive.verified,false,'the crash window is visible: an unchained archive copy fails closed');
 assert.equal(f.store.tombstoneCount(),1,'the tombstone is still in the trash');
 // Recovery is part of the next rotation: reconcileOrphans rolls the orphan
 // back (nothing was lost — the live side was never touched), then the
 // rotation simply runs again under a fresh rotationId.
 const redo=f.store.rotateDue({now:Date.now()});
 assert.equal(redo.rotated,true);assert.equal(redo.runCount,1);assert.deepEqual(redo.runs,[end.id]);
 assert.equal(f.store.get(end.id),null,'the redone rotation reclaims the live rows');
 assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1,'the orphan was replaced by the redo, not accumulated');
 const verdict=f.store.verifyIntegrity();
 assert.equal(verdict.archive.verified,true);assert.equal(verdict.events.verified,true);
 assert.equal(f.store.events(redo.rotationId).filter(e=>e.type==='archive.rotated').length,1,'exactly one chained event for the surviving rotation');
 }finally{await f.cleanup();}
});

test('a hard kill in the commit gap is repaired by the next startup and the rotation redoes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-sigkill-'));let runId;
 try{
  {const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
   const end=await run(engine,'return await ctx.agent({id:"a",prompt:"a"});','recover-2');
   runId=end.id;await engine.deleteRun(runId,{by:'cli'});await engine.configureTrash({trashRetentionDays:0});
   await engine.close();store.close();}
  // A child process takes the owner lock, starts the rotation, and dies
  // through the production injection seam (store.afterArchiveCommit) exactly
  // after the archive COMMIT and before the live transaction — a real crash,
  // not a mocked one. The committed archive copy must survive it.
  //
  // Cross-platform equivalence of the kill primitive: on POSIX SIGKILL is an
  // uninterceptable hard kill. On Windows, Node maps a self-SIGKILL onto
  // TerminateProcess with a death shape the execFile error does not expose
  // as `signal` (fork preview run 35696536334), so win32 uses process.exit(9)
  // instead: it terminates immediately and synchronously — no stack unwinding,
  // so the try/finally and store.close() never run and no further DB
  // statement executes. Because node:sqlite writes synchronously and the
  // archive transaction already committed with PRAGMA synchronous=FULL
  // before the seam fires, the durable crash-window state (archive side on
  // disk, live transaction never begun) is byte-identical under both
  // primitives — and exit(9)'s exit code, unlike TerminateProcess's, is
  // portably observable as code 9.
  const die=process.platform==='win32'?'process.exit(9)':'process.kill(process.pid,\'SIGKILL\')';
  const crash=`import {Store} from ${JSON.stringify(storeURL)};
const store=new Store(${JSON.stringify(dir)});
store.afterArchiveCommit=()=>${die};
try{store.rotateDue({now:Date.now()});}finally{store.close();}`;
  await assert.rejects(exec(process.execPath,['--input-type=module','-e',crash]),e=>process.platform==='win32'?e.code===9:e.signal==='SIGKILL');
  // Next startup: the Store constructor reconciles the orphan away, the live
  // tombstone is intact, and the rotation redoes cleanly. After an abnormal
  // child death, the kernel can lag slightly behind releasing the SQLite file
  // handles on win32 (and the stale owner.lock recheck can transiently report
  // the dead pid as alive); the reopen retries with backoff instead of failing
  // the recovery assertions on that timing — test-only, product semantics
  // untouched, non-win32 keeps the single-shot open.
  let store;for(let i=0;;i++){
   try{store=new Store(dir);break;}
   catch(e){if(process.platform!=='win32'||i>=19)throw e;await delay(100);}
  }
  const engine=new Engine(store,{workspace:dir,execute:async s=>({output:s.id})});
  try{
   const archive=store.archive();
   assert.deepEqual(archive.prepare('SELECT rotationId FROM rotations').all(),[],'startup reconciliation removed the orphaned rotation');
   assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM archive_runs').get().n,0);
   assert.equal(chainedCount(store),0);
   const tombstoned=store.get(runId);
   assert.ok(tombstoned?.deletedAt,'the live tombstone survived the crash untouched');
   assert.equal(store.tombstoneCount(),1);
   const redo=store.rotateDue({now:Date.now()});
   assert.equal(redo.rotated,true);assert.equal(redo.runCount,1);assert.deepEqual(redo.runs,[runId]);
   assert.equal(store.get(runId),null);
   assert.equal(archive.prepare('SELECT COUNT(*) AS n FROM rotations').get().n,1);
   const verdict=store.verifyIntegrity();
   assert.equal(verdict.archive.verified,true);assert.equal(verdict.events.verified,true);
  }finally{await engine.close();store.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('reconcileOrphans is a no-op for healthy rotations and an archive-less store',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 assert.deepEqual(f.store.reconcileOrphans(),{removed:[]},'no archive, nothing to do');
 const end=await run(f.engine,twoSteps,'recover-3');
 await f.engine.deleteRun(end.id);f.engine.configureTrash({trashRetentionDays:0});
 f.store.rotateDue({now:Date.now()});
 assert.deepEqual(f.store.reconcileOrphans(),{removed:[]},'a fully chained rotation is never an orphan');
 assert.equal(f.store.verifyArchive().verified,true);
 }finally{await f.cleanup();}
});
