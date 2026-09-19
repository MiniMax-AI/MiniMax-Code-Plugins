// SDD contract-first suite: dual hash-chain integrity audit (Store.integrityHeads / Store.verifyIntegrity + workflow_status tools surface).
// The implementation lands in parallel; until then these tests are the executable contract. Node >= 22 (node:sqlite).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {createToolHandler,TOOLS} from '../src/tools.mjs';
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-integrity-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
async function start(engine,script,input={}){const r=await engine.start({requestId:randomUUID(),name:'Integrity',executor:'demo',script,input});await engine.approve(r.id,{revision:1});return finish(engine,r.id);}
const GENESIS='0'.repeat(64);
// Independent recomputation of the contracted digest formulas over raw stored rows.
// r3 contract: digests bind row identity (events runId+seq, repair runId/id) as well as body.
function recomputeEvents(store){let prev=GENESIS;for(const r of store.db.prepare('SELECT seq,runId,body FROM events ORDER BY seq').all())prev=createHash('sha256').update(`${prev}:event:${r.runId}:${r.seq}:${r.body}`).digest('hex');return prev;}
function recomputeRepair(store){let prev=GENESIS;for(const r of store.db.prepare('SELECT rowid,runId,id,body FROM repair_cache ORDER BY rowid').all())prev=createHash('sha256').update(`${prev}:repair:${r.runId}/${r.id}:${r.body}`).digest('hex');return prev;}
const prefix=`const a=await ctx.agent({id:'a',prompt:'a'});const b=await ctx.agent({id:'b',prompt:'b',dependsOn:['a']});`;
const broken=prefix+`throw Error('bad synthesis');`;
const repaired=prefix+`return {a:a.output,b:b.output};`;
const candidate=(id,body='x')=>({id,kind:'agent',body});
const rawRepair=(store,runId,id,body)=>store.db.prepare('INSERT INTO repair_cache VALUES(?,?,?)').run(runId,id,body);

test('fresh store reports null heads; first event and candidate anchor both chains verifiably from genesis',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 assert.deepEqual(f.store.integrityHeads(),{events:null,repair:null});
 assert.equal(f.store.event(runId,'run.created',{name:'n'}).seq,1);
 f.store.saveRepairCandidate(runId,candidate('a'));
 const heads=f.store.integrityHeads();
 assert.equal(heads.events.upto,1);assert.equal(heads.events.head,recomputeEvents(f.store));
 assert.equal(heads.repair.upto,1);assert.equal(heads.repair.head,recomputeRepair(f.store));
 const v=f.store.verifyIntegrity();
 for(const face of ['events','repair']){assert.equal(v[face].verified,true);assert.equal(v[face].head,heads[face].head);assert.equal(v[face].checked,1);assert.equal(v[face].unchained,0);assert.equal(v[face].firstDivergence,null);}
 }finally{await f.cleanup();}
});

test('single-byte repair_cache tamper is detected at its row key and restoring the body heals verification',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.saveRepairCandidate(runId,candidate('a','original'));
 const original=f.store.db.prepare('SELECT body FROM repair_cache WHERE id=?').get('a').body;
 assert.equal(f.store.verifyIntegrity().repair.verified,true);
 f.store.db.prepare('UPDATE repair_cache SET body=? WHERE id=?').run(original.replace('o','0'),'a');
 const v=f.store.verifyIntegrity();
 assert.equal(v.repair.verified,false);
 assert.equal(v.repair.firstDivergence.key,`${runId}/a`);
 assert.notEqual(v.repair.firstDivergence.expectedHead,v.repair.firstDivergence.actualHead);
 f.store.db.prepare('UPDATE repair_cache SET body=? WHERE id=?').run(original,'a');
 assert.equal(f.store.verifyIntegrity().repair.verified,true);
 }finally{await f.cleanup();}
});

test('re-attributing events.runId and repair_cache runId/id without touching bodies, chains or heads is caught on both faces; restoring attribution heals',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runA=randomUUID(),runB=randomUUID();
 f.store.event(runA,'run.created',{name:'n'});
 f.store.saveRepairCandidate(runA,candidate('a'));
 assert.equal(f.store.verifyIntegrity().events.verified,true);
 assert.equal(f.store.verifyIntegrity().repair.verified,true);
 // Maintainer reproduction: only the identity columns move; body, chain rows and heads stay.
 f.store.db.prepare('UPDATE events SET runId=? WHERE seq=?').run(runB,1);
 f.store.db.prepare('UPDATE repair_cache SET runId=?,id=? WHERE runId=? AND id=?').run(runB,'b',runA,'a');
 const v=f.store.verifyIntegrity();
 assert.equal(v.events.verified,false);
 assert.equal(v.events.firstDivergence.key,`${runA}:1`);
 assert.match(v.events.firstDivergence.expectedHead,/^[0-9a-f]{64}$/);
 assert.match(v.events.firstDivergence.actualHead,/^[0-9a-f]{64}$/);
 assert.notEqual(v.events.firstDivergence.expectedHead,v.events.firstDivergence.actualHead);
 assert.equal(v.repair.verified,false);
 assert.equal(v.repair.firstDivergence.key,`${runA}/a`);
 assert.match(v.repair.firstDivergence.expectedHead,/^[0-9a-f]{64}$/);
 assert.match(v.repair.firstDivergence.actualHead,/^[0-9a-f]{64}$/);
 assert.notEqual(v.repair.firstDivergence.expectedHead,v.repair.firstDivergence.actualHead);
 f.store.db.prepare('UPDATE events SET runId=? WHERE seq=?').run(runA,1);
 f.store.db.prepare('UPDATE repair_cache SET runId=?,id=? WHERE runId=? AND id=?').run(runA,'a',runB,'b');
 const healed=f.store.verifyIntegrity();
 assert.equal(healed.events.verified,true);assert.equal(healed.events.firstDivergence,null);
 assert.equal(healed.repair.verified,true);assert.equal(healed.repair.firstDivergence,null);
 }finally{await f.cleanup();}
});

test('deleting the smaller of two event rows reports the first divergence at its identity key',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'n'});
 f.store.event(runId,'run.started');
 f.store.db.prepare('DELETE FROM events WHERE seq=?').run(1);
 const v=f.store.verifyIntegrity();
 assert.equal(v.events.verified,false);
 assert.equal(v.events.firstDivergence.key,`${runId}:1`);
 }finally{await f.cleanup();}
});

test('deleting the last of three anchored event rows fails closed at that row identity with a null actual head; restoring the row heals',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'n'});
 f.store.event(runId,'run.started');
 f.store.event(runId,'run.finished');
 const tail=f.store.db.prepare('SELECT seq,runId,body FROM events ORDER BY seq DESC LIMIT 1').get();
 assert.equal(tail.seq,3);
 f.store.db.prepare('DELETE FROM events WHERE seq=?').run(tail.seq);
 const v=f.store.verifyIntegrity().events;
 assert.equal(v.verified,false);
 assert.equal(v.checked,3);assert.equal(v.unchained,0,'deletion inside the anchored prefix is a chain divergence, not an unanchored tail');
 assert.equal(v.firstDivergence.key,`${runId}:${tail.seq}`);
 assert.match(v.firstDivergence.expectedHead,/^[0-9a-f]{64}$/);
 assert.equal(v.firstDivergence.expectedHead,v.head,'the deleted tail row carried the current head');
 assert.equal(v.firstDivergence.actualHead,null,'no live row remains at the recorded position');
 f.store.db.prepare('INSERT INTO events(seq,runId,body) VALUES(?,?,?)').run(tail.seq,tail.runId,tail.body);
 assert.equal(f.store.verifyIntegrity().events.verified,true,'restoring the exact row heals');
 }finally{await f.cleanup();}
});

test('deleting the middle of three anchored event rows fails closed at its identity key with an intermediate expected head',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'n'});
 f.store.event(runId,'run.started');
 f.store.event(runId,'run.finished');
 const rows=f.store.db.prepare('SELECT seq,runId,body FROM events ORDER BY seq').all();
 const middle=rows[1];
 assert.equal(middle.seq,2);
 f.store.db.prepare('DELETE FROM events WHERE seq=?').run(middle.seq);
 const v=f.store.verifyIntegrity().events;
 assert.equal(v.verified,false);
 assert.equal(v.checked,3);assert.equal(v.unchained,0);
 assert.equal(v.firstDivergence.key,`${runId}:${middle.seq}`);
 assert.equal(v.firstDivergence.actualHead,null);
 assert.notEqual(v.firstDivergence.expectedHead,v.head,'a middle row records an intermediate hash, not the head');
 f.store.db.prepare('INSERT INTO events(seq,runId,body) VALUES(?,?,?)').run(middle.seq,middle.runId,middle.body);
 assert.equal(f.store.verifyIntegrity().events.verified,true,'restoring the exact row heals');
 }finally{await f.cleanup();}
});

test('deleting the highest-rowid anchored repair_cache row fails closed at its row key; restoring the row heals',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 for(const id of ['a','b','c'])f.store.saveRepairCandidate(runId,candidate(id));
 const rows=f.store.db.prepare('SELECT rowid,runId,id,body FROM repair_cache ORDER BY rowid').all();
 const tail=rows.at(-1);
 assert.equal(tail.id,'c','rowid order matches insertion order');
 f.store.db.prepare('DELETE FROM repair_cache WHERE rowid=?').run(tail.rowid);
 const r=f.store.verifyIntegrity().repair;
 assert.equal(r.verified,false);
 assert.equal(r.checked,3);assert.equal(r.unchained,0,'deletion inside the anchored prefix is a chain divergence, not an unanchored tail');
 assert.equal(r.firstDivergence.key,`${runId}/${tail.id}`);
 assert.equal(r.firstDivergence.expectedHead,r.head,'the deleted tail row carried the current head');
 assert.equal(r.firstDivergence.actualHead,null,'no live row remains at the recorded position');
 f.store.db.prepare('INSERT INTO repair_cache(rowid,runId,id,body) VALUES(?,?,?,?)').run(tail.rowid,tail.runId,tail.id,tail.body);
 assert.equal(f.store.verifyIntegrity().repair.verified,true,'restoring the exact row heals');
 }finally{await f.cleanup();}
});

test('deleting the middle anchored repair_cache row fails closed at its row key with an intermediate expected head',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 for(const id of ['a','b','c'])f.store.saveRepairCandidate(runId,candidate(id));
 const rows=f.store.db.prepare('SELECT rowid,runId,id,body FROM repair_cache ORDER BY rowid').all();
 const middle=rows[1];
 assert.equal(middle.id,'b');
 f.store.db.prepare('DELETE FROM repair_cache WHERE rowid=?').run(middle.rowid);
 const r=f.store.verifyIntegrity().repair;
 assert.equal(r.verified,false);
 assert.equal(r.checked,3);assert.equal(r.unchained,0);
 assert.equal(r.firstDivergence.key,`${runId}/${middle.id}`);
 assert.equal(r.firstDivergence.actualHead,null);
 assert.notEqual(r.firstDivergence.expectedHead,r.head,'a middle row records an intermediate hash, not the head');
 f.store.db.prepare('INSERT INTO repair_cache(rowid,runId,id,body) VALUES(?,?,?,?)').run(middle.rowid,middle.runId,middle.id,middle.body);
 assert.equal(f.store.verifyIntegrity().repair.verified,true,'restoring the exact row heals');
 }finally{await f.cleanup();}
});

test('a forged integrity_events head fails verification while integrityHeads light-read mirrors settings',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'n'});
 // saveSetting stringifies its value, so the object form stores body exactly as the JSON {head,upto} the contract specifies.
 f.store.saveSetting('integrity_events',{head:'f'.repeat(64),upto:999});
 const heads=f.store.integrityHeads();
 assert.equal(heads.events.head,'f'.repeat(64));assert.equal(heads.events.upto,999);
 assert.equal(f.store.verifyIntegrity().events.verified,false);
 }finally{await f.cleanup();}
});

test('a raw-inserted repair row beyond upto counts as unchained and fails closed without a chain divergence',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.saveRepairCandidate(runId,candidate('a'));
 rawRepair(f.store,runId,'ghost','{"id":"ghost"}');
 const v=f.store.verifyIntegrity();
 assert.equal(v.repair.verified,false);
 assert.equal(v.repair.checked,1);assert.equal(v.repair.unchained,1);assert.equal(v.repair.firstDivergence,null);
 }finally{await f.cleanup();}
});

test('the first anchoring write implicitly commits pre-existing rows into the repair chain',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 rawRepair(f.store,runId,'pre','{"id":"pre"}');
 f.store.saveRepairCandidate(runId,candidate('a'));
 assert.equal(f.store.integrityHeads().repair.upto,2);
 assert.equal(f.store.verifyIntegrity().repair.verified,true);
 f.store.db.prepare('UPDATE repair_cache SET body=? WHERE id=?').run('{"id":"pre","tampered":true}','pre');
 const v=f.store.verifyIntegrity();
 assert.equal(v.repair.verified,false);
 assert.equal(v.repair.firstDivergence.key,`${runId}/pre`);
 }finally{await f.cleanup();}
});

test('workflow_status list form stays a plain array by default; verifyIntegrity:true opts into the object form with heads and verdicts',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'seed'});
 f.store.saveRepairCandidate(runId,candidate('a','seed'));
 const handler=createToolHandler(f.engine,()=>'http://127.0.0.1:1/');
 const list=await handler('workflow_status',{});
 assert.ok(Array.isArray(list));
 assert.equal(list.integrityHeads,undefined);
 assert.equal(list.integrity,undefined);
 const audited=await handler('workflow_status',{verifyIntegrity:true});
 assert.ok(audited&&Array.isArray(audited.runs));
 assert.ok(audited.integrityHeads&&audited.integrityHeads.events&&audited.integrityHeads.repair);
 assert.deepEqual(audited.integrityHeads,f.store.integrityHeads());
 assert.equal(typeof audited.integrity.events.verified,'boolean');
 assert.equal(typeof audited.integrity.repair.verified,'boolean');
 assert.deepEqual(audited.integrity,f.store.verifyIntegrity());
 const source=await start(f.engine,broken);
 assert.equal(source.status,'failed');
 const plain=await handler('workflow_status',{});
 assert.ok(Array.isArray(plain));assert.deepEqual(plain.map(r=>r.id),[source.id]);
 const single=await handler('workflow_status',{runId:source.id});
 assert.equal(single.id,source.id);assert.equal(single.integrityHeads,undefined);assert.equal(single.integrity,undefined);
 const def=TOOLS.find(t=>t.name==='workflow_status');
 assert.equal(def.inputSchema.properties.verifyIntegrity.type,'boolean');
 }finally{await f.cleanup();}
});

test('full broken-repair-approve-finish flow keeps both chains verified and honest',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const source=await start(f.engine,broken);
 assert.equal(source.status,'failed');
 const draft=await f.engine.repair(source.id,{requestId:randomUUID(),sourceUpdatedAt:source.updatedAt,script:repaired,reason:'Fix final synthesis',reuseStepIds:['a','b']});
 assert.equal(draft.status,'pending_review');
 await f.engine.approve(draft.id,{revision:1});
 const end=await finish(f.engine,draft.id);
 assert.equal(end.status,'succeeded');
 const heads=f.store.integrityHeads();
 assert.ok(heads.events.head&&heads.events.upto>0&&heads.repair.head&&heads.repair.upto>0);
 const v=f.store.verifyIntegrity();
 assert.equal(v.events.verified,true);assert.equal(v.repair.verified,true);
 assert.equal(v.events.unchained,0);assert.equal(v.repair.unchained,0);
 }finally{await f.cleanup();}
});

test('a row restored into an older sequence gap fails closed on both surfaces',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
  // Seed rows at seq 1 and 3 directly (legacy, pre-ledger), then anchor 1,3,4 via API writes.
  const ins=(seq,runId)=>f.store.db.prepare('INSERT INTO events(seq,runId,body) VALUES(?,?,?)').run(seq,runId,JSON.stringify({type:'seed',seq}));
  ins(1,'run-a');ins(3,'run-a');f.store.event('run-a','anchor',{});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM events').get().n,3,'anchored set is 1,3,4');
  // Simulate a restore/import that fills the gap at seq 2.
  ins(2,'run-b');
  const v=f.store.verifyIntegrity().events;
  assert.equal(v.verified,false,'gap row inside the anchored range must fail closed');
  assert.deepEqual(v.firstDivergence,{key:'run-b:2',expectedHead:null,actualHead:null});
  f.store.db.prepare('DELETE FROM events WHERE seq=2').run();
  assert.equal(f.store.verifyIntegrity().events.verified,true,'restoring the anchored set heals');
  // Same shape on repair_cache: legacy rows at rowid 1 and 3, anchor, then fill rowid 2.
  const insr=(rowid,runId,id)=>f.store.db.prepare('INSERT INTO repair_cache(rowid,runId,id,body) VALUES(?,?,?,?)').run(rowid,runId,id,JSON.stringify({id,kind:'agent'}));
  insr(1,'run-a','a');insr(3,'run-a','c');f.store.saveRepairCandidate('run-a',{id:'d',kind:'agent'});
  insr(2,'run-b','b');
  const r=f.store.verifyIntegrity().repair;
  assert.equal(r.verified,false);assert.equal(r.firstDivergence.key,'run-b/b');
  }finally{await f.cleanup();}
});

test('a raw tail insert stays rejected across subsequent normal writes (no silent adoption)',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
  // events: legit pos1 -> raw pos2 (rejected) -> normal pos3 must NOT absorb pos2.
  f.store.event('run-a','legit',{});
  f.store.db.prepare('INSERT INTO events(runId,body) VALUES(?,?)').run('run-raw',JSON.stringify({type:'raw'}));
  let v=f.store.verifyIntegrity().events;
  assert.equal(v.verified,false);assert.equal(v.unchained,1);
  f.store.event('run-a','after',{});
  v=f.store.verifyIntegrity().events;
  assert.equal(v.verified,false,'normal write must not silently anchor the injected row');
  assert.equal(v.unchained,0);assert.equal(v.checked,2);
  assert.equal(v.firstDivergence.key,'run-raw:2','in-row gap is reported with the injected identity');
  // repair_cache: same shape.
  f.store.saveRepairCandidate('run-a',{id:'legit',kind:'agent'});
  f.store.db.prepare('INSERT INTO repair_cache(runId,id,body) VALUES(?,?,?)').run('run-raw','raw',JSON.stringify({id:'raw',kind:'agent'}));
  let r=f.store.verifyIntegrity().repair;
  assert.equal(r.verified,false);assert.equal(r.unchained,1);
  f.store.saveRepairCandidate('run-a',{id:'after',kind:'agent'});
  r=f.store.verifyIntegrity().repair;
  assert.equal(r.verified,false);assert.equal(r.unchained,0);assert.equal(r.checked,2);
  assert.equal(r.firstDivergence.key,'run-raw/raw');
  // Removing the injected rows heals both surfaces.
  f.store.db.prepare('DELETE FROM events WHERE runId=?').run('run-raw');
  f.store.db.prepare('DELETE FROM repair_cache WHERE runId=?').run('run-raw');
  assert.equal(f.store.verifyIntegrity().events.verified,true);
  assert.equal(f.store.verifyIntegrity().repair.verified,true);
  }finally{await f.cleanup();}
});
