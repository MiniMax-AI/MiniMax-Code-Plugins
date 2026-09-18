import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
    this.owner=randomUUID();this.txDepth=0;
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
  list() {return this.db.prepare("SELECT body FROM runs ORDER BY CASE WHEN json_extract(body,'$.status') IN ('running','queued','stopping','pausing') THEN 0 WHEN json_extract(body,'$.status')='needs_attention' THEN 1 ELSE 2 END, rowid DESC LIMIT 100").all().map(r=>JSON.parse(r.body));}
  step(runId,id) {const r=this.db.prepare('SELECT body FROM steps WHERE runId=? AND id=?').get(runId,id);return r?JSON.parse(r.body):null;}
  steps(runId) {return this.db.prepare('SELECT body FROM steps WHERE runId=? ORDER BY rowid').all(runId).map(r=>JSON.parse(r.body));}
  // All match keys (contextHash, lineageHash) are stamped on the step body at
  // creation, so filtering happens in SQL and LIMIT applies after the full match.
  // Rows without the stamped hashes (legacy runs) never match: cross-run reuse is
  // an opt-in feature and older steps are not candidates.
  findCrossRunReuse({contextHash,requestHash,lineageHash,excludeRunId,limit=20}) {return this.db.prepare("SELECT runId,body AS stepBody FROM steps WHERE runId<>? AND json_extract(body,'$.kind')='agent' AND json_extract(body,'$.status')='succeeded' AND json_extract(body,'$.requestHash')=? AND json_extract(body,'$.contextHash')=? AND json_extract(body,'$.lineageHash')=? ORDER BY rowid DESC LIMIT ?").all(excludeRunId,requestHash,contextHash,lineageHash,limit).map(r=>{const step=JSON.parse(r.stepBody);return {runId:r.runId,stepId:step.id,step};});}
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
      repair:face('repair','repair','repair_cache','rowid','SELECT runId,id,body FROM repair_cache WHERE rowid=?',row=>`${row.runId}/${row.id}`)};
  }
  releaseLock() {closeSync(this.fd);try{if(JSON.parse(readFileSync(this.lock,'utf8')).owner===this.owner)unlinkSync(this.lock);}catch{}}
  close() {this.db.close();this.releaseLock();}
}
