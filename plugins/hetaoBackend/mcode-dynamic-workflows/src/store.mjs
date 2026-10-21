import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hash } from './common.mjs';
// Startup auto-rotation thresholds (checked once per service start). Trash
// volume: 500 tombstones is roughly 1.5 years at ten finished runs per day —
// past that the trash listing and the due-scan stop being small state. Library
// volume: ~100MB of runs rows is where list()/snapshot() JSON payloads start
// to tax the dashboard on commodity hardware. Both are coarse trip-wires, not
// quotas: below them the retention clock (purgeAfter) alone decides, and
// rotation otherwise happens only through the explicit CLI face.
export const ROTATE_TOMBSTONE_THRESHOLD=500;
export const ROTATE_RUNS_BYTES_THRESHOLD=100*1024*1024;
// Bounded rotation budgets. One batch is the unit of rotation work AND of
// crash recovery: at most ROTATE_BATCH_RUNS tombstones or ROTATE_BATCH_BYTES
// of row data (whichever binds first) is materialized in memory, and each
// batch commits its own archive-copy + live-delete transaction pair. 50 runs
// is roughly one busy dashboard day of finished runs and keeps a batch well
// inside an HTTP request; 8 MiB caps the JSON held in memory per batch (a
// single run larger than the budget still rotates alone in its own batch so
// one oversized tombstone can never wedge rotation).
export const ROTATE_BATCH_RUNS=50;
export const ROTATE_BATCH_BYTES=8*1024*1024;
// Upper bound of batches one API/CLI rotate call may chain before reporting
// the honest remainder: 20 batches = 1000 tombstones per call. Rotation work
// stays bounded per request; a larger backlog drains over repeated calls.
export const ROTATE_MAX_BATCHES=20;
// Canonical manifest hash over exported runs+steps rows in deterministic
// (runId, step id) order. Rotation and verification share this single
// implementation so the two hashes can never drift; checks recomputes it
// independently over the raw archive rows.
export function archiveManifestHash(entries) {return hash(entries);}
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true,mode:0o700}); this.lock=join(dir,'owner.lock');
    try { this.fd=openSync(this.lock,'wx',0o600); } catch(e) {
      if(e.code!=='EEXIST') throw e;
      let pid; try{pid=JSON.parse(readFileSync(this.lock,'utf8')).pid;}catch{throw new Error('状态目录锁损坏，请人工检查 owner.lock');}
      let alive=true; try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
      if(alive) throw new Error('同一状态目录已有运行中的服务，请连接既有服务');
      unlinkSync(this.lock); this.fd=openSync(this.lock,'wx',0o600);
    }
    this.owner=randomUUID();this.txDepth=0;this.archivePath=join(dir,'archive.db');
    // Real-failure injection seam (undefined in production): rotateDue calls
    // it exactly after the archive database has committed a batch and before
    // the live transaction starts — the one gap no SQLite transaction can
    // cover. The crash-window checks set it to kill/throw so the durable
    // on-disk crash state is produced by a genuine failure, not a mock.
    this.afterArchiveCommit=null;
    try {
    writeFileSync(this.fd,JSON.stringify({pid:process.pid,owner:this.owner}));
    this.db=new DatabaseSync(join(dir,'workflows.sqlite'));
    // The kernel-held SQLite lock is authoritative if stale lockfile reclamation
    // races with another starter. Keep it for this service connection's lifetime.
    this.db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,requestId TEXT UNIQUE,requestHash TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps(runId TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(runId,id));
      CREATE TABLE IF NOT EXISTS repair_cache(runId TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(runId,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,runId TEXT,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_events ON events(runId,seq);
      CREATE TABLE IF NOT EXISTS integrity_rows(surface TEXT NOT NULL,pos INTEGER NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(surface,pos));`);
    // Recovery must inspect every unfinished run, not just the dashboard page.
    const unfinished=this.db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.status') IN ('running','queued','stopping','pausing')").all();
    for(const row of unfinished) {const run=JSON.parse(row.body);
      run.status='needs_attention';run.error='上次服务异常终止。先确认旧 Agent 已停止，再恢复。';this.save(run);
    }
    // Crash-window reconciliation (see reconcileOrphans): repair any rotation
    // that committed its archive copy but died before the live commit, so the
    // store this connection serves is never carrying an orphaned archive.
    this.reconcileOrphans();
    }catch(error){this.db?.close();this.releaseLock();throw error;}
  }
  transaction(fn) {if(this.txDepth)return fn();this.txDepth=1;this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.txDepth=0;}}
  templates() {return this.db.prepare('SELECT body FROM templates ORDER BY rowid DESC').all().map(r=>JSON.parse(r.body));}
  template(id) {const r=this.db.prepare('SELECT body FROM templates WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
  saveTemplate(value) {this.db.prepare('INSERT INTO templates VALUES(?,?)').run(value.id,JSON.stringify(value));}
  deleteTemplate(id) {return this.db.prepare('DELETE FROM templates WHERE id=?').run(id).changes>0;}
  setting(key) {const row=this.db.prepare('SELECT body FROM settings WHERE key=?').get(key);return row?JSON.parse(row.body):undefined;}
  saveSetting(key,value) {this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key,JSON.stringify(value));}
  save(run) {this.db.prepare('INSERT INTO runs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,run.requestId,run.requestHash,JSON.stringify(run));}
  get(id) {const r=this.db.prepare('SELECT body FROM runs WHERE id=?').get(id);return r ? JSON.parse(r.body):null;}
  byRequest(id) {const r=this.db.prepare('SELECT body FROM runs WHERE requestId=?').get(id);return r ? JSON.parse(r.body):null;}
  // Tombstoned runs (deletedAt stamped) never appear in the live list; the
  // trash listing below is their only index face.
  list() {return this.db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.deletedAt') IS NULL ORDER BY CASE WHEN json_extract(body,'$.status') IN ('running','queued','stopping','pausing') THEN 0 WHEN json_extract(body,'$.status')='needs_attention' THEN 1 ELSE 2 END, rowid DESC LIMIT 100").all().map(r=>JSON.parse(r.body));}
  listTrash() {return this.db.prepare("SELECT body FROM runs WHERE json_extract(body,'$.deletedAt') IS NOT NULL ORDER BY json_extract(body,'$.deletedAt') DESC LIMIT 100").all().map(r=>JSON.parse(r.body));}
  restampTrashPurge(days) {this.transaction(()=>{for(const row of this.db.prepare("SELECT id,body FROM runs WHERE json_extract(body,'$.deletedAt') IS NOT NULL").all()){const run=JSON.parse(row.body);this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify({...run,purgeAfter:run.deletedAt+days*86400000}),row.id);}});}
  // Atomic tombstone/restore primitives: the run body change and its
  // run.deleted/run.restored audit event land in ONE live transaction. An
  // event-insert failure (the last write in the transaction) rolls the body
  // change back with it, so the operation fails closed with zero state
  // change instead of leaving a mutated run whose promised audit event never
  // landed. The caller mutates the run object in memory first; on failure the
  // exception propagates and the persisted state is untouched.
  tombstoneRun(run,eventData={}) {return this.transaction(()=>{this.save(run);return this.event(run.id,'run.deleted',eventData);});}
  untombstoneRun(run,eventData={}) {return this.transaction(()=>{this.save(run);return this.event(run.id,'run.restored',eventData);});}
  tombstoneCount() {return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE json_extract(body,'$.deletedAt') IS NOT NULL").get().n);}
  // Size proxy for the runs table: body bytes plus a fixed per-row overhead
  // allowance (row header, id/request columns). SQLite exposes no exact
  // per-table page accounting; a proxy is sufficient for a coarse trigger.
  runsBytes() {return Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0)+COUNT(*)*100 AS n FROM runs').get().n);}
  step(runId,id) {const r=this.db.prepare('SELECT body FROM steps WHERE runId=? AND id=?').get(runId,id);return r?JSON.parse(r.body):null;}
  steps(runId) {return this.db.prepare('SELECT body FROM steps WHERE runId=? ORDER BY rowid').all(runId).map(r=>JSON.parse(r.body));}
  // All match keys (contextHash, lineageHash) are stamped on the step body at
  // creation, so filtering happens in SQL and LIMIT applies after the full match.
  // Rows without the stamped hashes (legacy runs) never match: cross-run reuse is
  // an opt-in feature and older steps are not candidates. Tombstoned source runs
  // are excluded here too: a trashed run's steps must not resurface as reuse
  // candidates (ghost data) until the run is restored.
    findCrossRunReuse({contextHash,requestHash,lineageHash,excludeRunId,limit=20}) {return this.db.prepare("SELECT runId,body AS stepBody FROM steps WHERE runId<>? AND json_extract(body,'$.kind')='agent' AND json_extract(body,'$.status')='succeeded' AND json_extract(body,'$.requestHash')=? AND json_extract(body,'$.contextHash')=? AND json_extract(body,'$.lineageHash')=? AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.id=steps.runId AND json_extract(runs.body,'$.deletedAt') IS NOT NULL) ORDER BY rowid DESC LIMIT ?").all(excludeRunId,requestHash,contextHash,lineageHash,limit).map(r=>{const step=JSON.parse(r.stepBody);return {runId:r.runId,stepId:step.id,step};});}
  saveStep(runId,step) {this.db.prepare('INSERT INTO steps VALUES(?,?,?) ON CONFLICT(runId,id) DO UPDATE SET body=excluded.body').run(runId,step.id,JSON.stringify(step));}
  repairCandidate(runId,id) {const r=this.db.prepare('SELECT body FROM repair_cache WHERE runId=? AND id=?').get(runId,id);return r?JSON.parse(r.body):null;}
  saveRepairCandidate(runId,step) {this.transaction(()=>{const rowid=Number(this.db.prepare('INSERT INTO repair_cache VALUES(?,?,?)').run(runId,step.id,JSON.stringify(step)).lastInsertRowid);this.chainAdvance('repair','repair','SELECT rowid AS pos,runId,id,body FROM repair_cache WHERE rowid>? AND rowid<=? ORDER BY rowid',rowid,r=>`${r.runId}/${r.id}`);});}
  event(runId,type,data={}) {const event={...data,type,time:Date.now()};return this.transaction(()=>{const seq=Number(this.db.prepare('INSERT INTO events(runId,body) VALUES(?,?)').run(runId,JSON.stringify(event)).lastInsertRowid);this.chainAdvance('event','events','SELECT seq AS pos,runId,body FROM events WHERE seq>? AND seq<=? ORDER BY seq',seq,r=>`${r.runId}:${r.pos}`);return {seq,...event};});}
  events(runId,after=0,limit=150) {return this.db.prepare('SELECT seq,body FROM events WHERE runId=? AND seq>? ORDER BY seq LIMIT ?').all(runId,after,limit).map(e=>({seq:e.seq,...JSON.parse(e.body)}));}
  rowHash(prev,kind,key,body) {return createHash('sha256').update(`${prev}:${kind}:${key}:${body}`).digest('hex');}
  // Bulk adoption of pre-existing rows is an initial-creation behavior only: it
  // anchors whatever the table held when the chain first appears. Once a head
  // exists, each write anchors ONLY its own new position — rows injected into the
  // range between the head and a later write stay unanchored and verification
  // keeps failing closed on them instead of silently legitimizing them.
  chainAdvance(kind,surface,sql,newUpto,keyOf) {const tail=this.setting(`integrity_${surface}`);let prev=tail?.head??'0'.repeat(64);
   const range=tail?`SELECT * FROM (${sql}) WHERE pos=${newUpto}`:sql;
   for(const r of this.db.prepare(range).all(tail?.upto??0,newUpto)){const k=keyOf(r);prev=this.rowHash(prev,kind,k,r.body);this.db.prepare('INSERT OR REPLACE INTO integrity_rows VALUES(?,?,?,?)').run(surface,r.pos,k,prev);}this.saveSetting(`integrity_${surface}`,{head:prev,upto:newUpto});}
  integrityHeads() {return {events:this.setting('integrity_events')??null,repair:this.setting('integrity_repair')??null};}
  verifyIntegrity() {
    // Each ledger link is re-checked against the live row's own identity columns:
    // the key is re-derived from the row and must equal the recorded key before that
    // recorded key may take part in any digest recomputation, so re-attributing a
    // row (events.runId / repair_cache runId+id) is detected like any body edit.
    const genesis='0'.repeat(64);const face=(kind,surface,table,posCol,rowSql,keyOf)=>{
    const skey=`integrity_${surface}`;const rec=this.setting(skey);const total=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    if(!rec)return {head:null,upto:0,verified:null,checked:0,unchained:total,firstDivergence:null};
    const rows=this.db.prepare('SELECT pos,key,hash FROM integrity_rows WHERE surface=? ORDER BY pos').all(surface);
    const unchained=Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${posCol}>?`).get(rec.upto).n);
    let prev=genesis,firstDivergence=null;
    for(const r of rows){const row=this.db.prepare(rowSql).get(r.pos);const key=row?keyOf(row,r.pos):null;
      const actual=row?this.rowHash(prev,kind,key,row.body):null;
      if(!firstDivergence&&(!row||key!==r.key||actual!==r.hash))firstDivergence={key:r.key,expectedHead:r.hash,actualHead:actual};
      prev=r.hash;}
    // Coverage: every source row inside the anchored range must carry a ledger
    // link. A row restored into an older sequence gap (pos<=upto, no link) would
    // otherwise be invisible to both the walk above and the unchained tail count.
    if(!firstDivergence){const anchored=new Set(rows.map(r=>r.pos));
      const gap=this.db.prepare(`SELECT ${posCol} AS __pos, * FROM ${table} WHERE ${posCol}<=? ORDER BY ${posCol}`).all(rec.upto).find(r=>!anchored.has(r.__pos));
      if(gap)firstDivergence={key:keyOf(gap,gap.__pos),expectedHead:null,actualHead:null};}
    // Verification covers the anchored prefix; any unanchored row fails closed.
    const verified=!firstDivergence&&prev===rec.head&&unchained===0;
    return {head:rec.head,upto:rec.upto,verified,checked:rows.length,unchained,firstDivergence};};
    return {events:face('event','events','events','seq','SELECT runId,body FROM events WHERE seq=?',(row,pos)=>`${row.runId}:${pos}`),
      repair:face('repair','repair','repair_cache','rowid','SELECT runId,id,body FROM repair_cache WHERE rowid=?',row=>`${row.runId}/${row.id}`),
      // Archive face: the events/repair ledgers are untouched by rotation
      // (events never move), so this face only cross-checks the sidecar
      // archive against the manifest hashes anchored on the events chain.
      archive:this.verifyArchive()};
  }
  // Sidecar archive for rotated tombstones: same data directory, separate
  // database. runs/steps rows move here verbatim; events NEVER leave the live
  // database. Each rotation writes its own copies keyed by (rotationId, runId)
  // rather than a plain runs PK, so a run that is restored, re-deleted and
  // re-rotated can never rewrite rows an earlier rotation's manifestHash still
  // covers — every historical manifest stays independently verifiable.
  archive() {
   if(this.archiveDb)return this.archiveDb;
   const db=new DatabaseSync(this.archivePath);
   db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
     CREATE TABLE IF NOT EXISTS archive_runs(rotationId TEXT NOT NULL,runId TEXT NOT NULL,requestId TEXT NOT NULL,requestHash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rotationId,runId));
     CREATE TABLE IF NOT EXISTS archive_steps(rotationId TEXT NOT NULL,runId TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rotationId,runId,id));
     CREATE TABLE IF NOT EXISTS rotations(rotationId TEXT PRIMARY KEY,rotatedAt INTEGER NOT NULL,manifestHash TEXT NOT NULL,runCount INTEGER NOT NULL,bytes INTEGER NOT NULL);`);
   this.archiveDb=db;return db;
  }
  // Crash-window reconciliation across the two databases. Rotation commits
  // the archive side FIRST (archive_runs + archive_steps + the rotations
  // record) and the live side SECOND (row deletes + archive.rotated event in
  // ONE live transaction); no SQLite transaction can span both files. A crash
  // in between leaves exactly one corrupt shape: a rotations record whose
  // archive.rotated event never landed. The live transaction never ran, so
  // the runs/steps rows are still in place and untouched — rolling the
  // archive copy back is therefore always safe and loses nothing:
  // reconcileOrphans() deletes such orphaned rotations (archive rows +
  // rotations record) and leaves the live library alone. It runs at startup
  // (Store constructor) and before every rotation, after which the rotation
  // simply runs again under a fresh rotationId, so redo is idempotent by
  // construction.
  reconcileOrphans() {
   if(!existsSync(this.archivePath))return {removed:[]};
   const archive=this.archive();
   const chained=new Set(this.db.prepare("SELECT runId FROM events WHERE json_extract(body,'$.type')='archive.rotated'").all().map(e=>e.runId));
   const removed=[];
   for(const {rotationId} of archive.prepare('SELECT rotationId FROM rotations').all()){
    if(chained.has(rotationId))continue;
    archive.exec('BEGIN IMMEDIATE');
    try{
     archive.prepare('DELETE FROM archive_runs WHERE rotationId=?').run(rotationId);
     archive.prepare('DELETE FROM archive_steps WHERE rotationId=?').run(rotationId);
     archive.prepare('DELETE FROM rotations WHERE rotationId=?').run(rotationId);
     archive.exec('COMMIT');
    }catch(e){archive.exec('ROLLBACK');throw e;}
    removed.push(rotationId);
   }
   return {removed};
  }
  dueTombstoneCount(now=Date.now()) {return Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE json_extract(body,'$.deletedAt') IS NOT NULL AND json_extract(body,'$.purgeAfter')<=?").get(now).n);}
  // Rotate due tombstones (purgeAfter <= now) into the archive and drop their
  // live runs/steps rows, in bounded batches. Within a batch the ordering is
  // fixed and crash-safe: archive-first (rows + rotations record, one archive
  // transaction), then live-second (deletes + the audit event in one live
  // transaction). Each batch is its own rotation and its own recovery unit
  // (see reconcileOrphans). maxBatches bounds one call — the startup path
  // uses exactly 1 so service start never blocks on a backlog; the API/CLI
  // face uses ROTATE_MAX_BATCHES — and `remaining` reports honestly how many
  // due tombstones are still unrotated. The cursor is implicit: processed
  // rows are deleted inside the batch, so re-issuing the same ordered query
  // advances on its own. Single-batch results keep the historical flat
  // rotationId/manifestHash shape; multi-batch callers read `rotations`.
  rotateDue({now=Date.now(),maxBatches=1}={}) {
   this.reconcileOrphans();
   const readSteps=this.db.prepare('SELECT id,body FROM steps WHERE runId=? ORDER BY id'),dueQuery=this.db.prepare("SELECT id,requestId,requestHash,body FROM runs WHERE json_extract(body,'$.deletedAt') IS NOT NULL AND json_extract(body,'$.purgeAfter')<=? ORDER BY id LIMIT ?");
   const rotations=[];
   for(let batch=0;batch<maxBatches;batch++){
    const due=dueQuery.all(now,ROTATE_BATCH_RUNS);
    if(!due.length)break;
    // Byte budget: stop adding entries before the batch would exceed
    // ROTATE_BATCH_BYTES; the first entry always joins so one oversized run
    // cannot wedge the rotation (it gets a batch of its own).
    const entries=[];let bytes=0;
    for(const r of due){
     const steps=readSteps.all(r.id);
     const entryBytes=Buffer.byteLength(r.body)+steps.reduce((m,s)=>m+Buffer.byteLength(s.body),0);
     if(entries.length&&bytes+entryBytes>ROTATE_BATCH_BYTES)break;
     entries.push({run:{id:r.id,requestId:r.requestId,requestHash:r.requestHash,body:r.body},steps});bytes+=entryBytes;
    }
    const rotationId=randomUUID(),manifestHash=archiveManifestHash(entries);
    const archive=this.archive();
    archive.exec('BEGIN IMMEDIATE');
    try{
     const insertRun=archive.prepare('INSERT OR REPLACE INTO archive_runs VALUES(?,?,?,?,?)'),insertStep=archive.prepare('INSERT OR REPLACE INTO archive_steps VALUES(?,?,?,?)');
     for(const entry of entries){insertRun.run(rotationId,entry.run.id,entry.run.requestId,entry.run.requestHash,entry.run.body);for(const step of entry.steps)insertStep.run(rotationId,entry.run.id,step.id,step.body);}
     archive.prepare('INSERT INTO rotations VALUES(?,?,?,?,?)').run(rotationId,Date.now(),manifestHash,entries.length,bytes);
     archive.exec('COMMIT');
    }catch(e){archive.exec('ROLLBACK');throw e;}
    // The un-transactionable gap between the two commits — the injection
    // seam fires here (undefined in production; the checks use it to land
    // the real crash-window state on disk).
    this.afterArchiveCommit?.(rotationId);
    this.transaction(()=>{
     const deleteSteps=this.db.prepare('DELETE FROM steps WHERE runId=?'),deleteRun=this.db.prepare('DELETE FROM runs WHERE id=?');
     for(const entry of entries){deleteSteps.run(entry.run.id);deleteRun.run(entry.run.id);}
     this.event(rotationId,'archive.rotated',{runs:entries.map(entry=>entry.run.id),manifestHash,runCount:entries.length,bytes});
    });
    rotations.push({rotationId,manifestHash,runCount:entries.length,runs:entries.map(entry=>entry.run.id),bytes});
   }
   const remaining=this.dueTombstoneCount(now);
   if(!rotations.length)return {rotated:false,runCount:0,runs:[],rotationId:null,manifestHash:null,bytes:0,remaining,rotations:[]};
   const summary=rotations.reduce((acc,r)=>({runCount:acc.runCount+r.runCount,runs:[...acc.runs,...r.runs],bytes:acc.bytes+r.bytes}),{runCount:0,runs:[],bytes:0});
   const flat=rotations.length===1?{rotationId:rotations[0].rotationId,manifestHash:rotations[0].manifestHash}:{rotationId:null,manifestHash:null};
   return {rotated:true,...summary,...flat,remaining,rotations};
  }
  // Archive verification recomputes each rotation's manifest from the archived
  // rows and compares it against BOTH the rotations record (tamperable sidecar)
  // and the archive.rotated event anchored on the events hash chain (the trust
  // anchor). The chain is consulted FIRST and is the gate: every rotation the
  // chain promises must exist in the archive, so a missing archive.db
  // (whole-archive deletion) or a missing rotations record fails closed BEFORE
  // any archive-side read could return an all-clear. Extra cross-checks:
  // archive rows may not exist outside known rotations, so deleting archive
  // history fails closed from both directions. Only a chain that promises
  // nothing plus a missing sidecar (a clean install) verifies green.
  verifyArchive() {
   const chained=this.db.prepare("SELECT runId FROM events WHERE json_extract(body,'$.type')='archive.rotated'").all().map(e=>e.runId);
   if(!existsSync(this.archivePath)){
    if(!chained.length)return {exists:false,rotations:0,checked:0,verified:true,results:[],divergences:[]};
    return {exists:false,rotations:0,checked:0,verified:false,results:[],divergences:[`whole-archive-deleted: the events chain anchors ${chained.length} rotation(s) but archive.db is missing`]};
   }
   const archive=this.archive();
   const rotations=archive.prepare('SELECT rotationId,manifestHash,runCount FROM rotations ORDER BY rotationId').all();
   const results=[],divergences=[];
   for(const rotation of rotations){
    const audit=this.db.prepare('SELECT body FROM events WHERE runId=?').all(rotation.rotationId).map(e=>JSON.parse(e.body)).filter(e=>e.type==='archive.rotated');
    const entries=archive.prepare('SELECT runId AS id,requestId,requestHash,body FROM archive_runs WHERE rotationId=? ORDER BY runId').all(rotation.rotationId)
     .map(run=>({run,steps:archive.prepare('SELECT id,body FROM archive_steps WHERE rotationId=? AND runId=? ORDER BY id').all(rotation.rotationId,run.id)}));
    const actual=archiveManifestHash(entries),event=audit[0],problems=[];
    if(audit.length!==1)problems.push(`expected exactly one archive.rotated event, found ${audit.length}`);
    if(event&&event.manifestHash!==rotation.manifestHash)problems.push('rotations.manifestHash differs from the chained event');
    if(event&&event.manifestHash!==actual)problems.push('archived rows recompute to a different manifest');
    if(event&&event.runCount!==rotation.runCount)problems.push('event runCount differs from the rotations record');
    if(entries.length!==rotation.runCount)problems.push(`archived ${entries.length} run rows for runCount ${rotation.runCount}`);
    if(problems.length)divergences.push(`rotation ${rotation.rotationId}: ${problems.join('; ')}`);
    results.push({rotationId:rotation.rotationId,runCount:rotation.runCount,verified:problems.length===0});
   }
   for(const runId of chained)if(!rotations.some(rotation=>rotation.rotationId===runId))divergences.push(`rotation-missing: chained rotation ${runId} has no rotations record in the archive`);
   for(const orphan of archive.prepare('SELECT DISTINCT rotationId FROM archive_runs WHERE rotationId NOT IN (SELECT rotationId FROM rotations)').all())divergences.push(`archive rows exist for unknown rotation ${orphan.rotationId}`);
   return {exists:true,rotations:rotations.length,checked:rotations.length,verified:divergences.length===0,results,divergences};
  }
  // Latest rotation that archived the run, or null when the run was never
  // archived. Does not create the archive database for a negative answer.
  archiveOrigin(runId) {
   if(!existsSync(this.archivePath))return null;
   const row=this.archive().prepare('SELECT a.rotationId AS rotationId FROM archive_runs a JOIN rotations r ON r.rotationId=a.rotationId WHERE a.runId=? ORDER BY r.rotatedAt DESC,a.rotationId DESC LIMIT 1').get(runId);
   return row?{rotationId:row.rotationId}:null;
  }
  // Copy a run's archived runs/steps rows back into the live library (id
  // idempotent through upserts), clear its tombstone and append one
  // run.restored {origin:'archive'} audit event — all in one transaction.
  // The archive keeps its copy: restore is a copy-back, not a move.
  restoreArchived(runId,{by='cli'}={}) {
   if(!existsSync(this.archivePath))return null;
   const row=this.archive().prepare('SELECT a.rotationId AS rotationId,a.requestId AS requestId,a.requestHash AS requestHash,a.body AS body FROM archive_runs a JOIN rotations r ON r.rotationId=a.rotationId WHERE a.runId=? ORDER BY r.rotatedAt DESC,a.rotationId DESC LIMIT 1').get(runId);
   if(!row)return null;
   // Rotation frees the requestId; a newer live run may have claimed it since.
   // Restoring must not silently evict that run — fail loud instead.
   const conflict=this.db.prepare('SELECT id FROM runs WHERE requestId=? AND id<>?').get(row.requestId,runId);
   if(conflict)throw new Error(`requestId 已被新的工作流（${conflict.id}）占用，无法从归档恢复 ${runId}；请先处理占用的运行`);
   const run=JSON.parse(row.body);
   delete run.deletedAt;delete run.deletedBy;delete run.purgeAfter;
   const steps=this.archive().prepare('SELECT id,body FROM archive_steps WHERE rotationId=? AND runId=? ORDER BY id').all(row.rotationId,runId);
   this.transaction(()=>{
    this.save(run);
    const insert=this.db.prepare('INSERT INTO steps VALUES(?,?,?) ON CONFLICT(runId,id) DO UPDATE SET body=excluded.body');
    for(const step of steps)insert.run(runId,step.id,step.body);
    this.event(runId,'run.restored',{by,origin:'archive',rotationId:row.rotationId});
   });
   return {id:runId,rotationId:row.rotationId,steps:steps.length};
  }
  releaseLock() {closeSync(this.fd);try{if(JSON.parse(readFileSync(this.lock,'utf8')).owner===this.owner)unlinkSync(this.lock);}catch{}}
  close() {this.archiveDb?.close();this.db.close();this.releaseLock();}
}
