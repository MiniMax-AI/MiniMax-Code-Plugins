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
function recomputeEvents(store){let prev=GENESIS;for(const r of store.db.prepare('SELECT seq,body FROM events ORDER BY seq').all())prev=createHash('sha256').update(`${prev}:event:${r.seq}:${r.body}`).digest('hex');return prev;}
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

test('deleting the smaller of two event rows reports the first divergence at key 1',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'n'});
 f.store.event(runId,'run.started');
 f.store.db.prepare('DELETE FROM events WHERE seq=?').run(1);
 const v=f.store.verifyIntegrity();
 assert.equal(v.events.verified,false);
 assert.equal(v.events.firstDivergence.key,'1');
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

test('a raw-inserted repair row beyond upto counts as unchained and never fails verification',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.saveRepairCandidate(runId,candidate('a'));
 rawRepair(f.store,runId,'ghost','{"id":"ghost"}');
 const v=f.store.verifyIntegrity();
 assert.equal(v.repair.verified,true);
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

test('workflow_status list form carries integrityHeads plus optional integrity; schema declares verifyIntegrity; single-run form unchanged',async()=>{
 const f=await fixture(async s=>({output:s.id}));try{
 const runId=randomUUID();
 f.store.event(runId,'run.created',{name:'seed'});
 f.store.saveRepairCandidate(runId,candidate('a','seed'));
 const handler=createToolHandler(f.engine,()=>'http://127.0.0.1:1/');
 const list=await handler('workflow_status',{});
 assert.ok(list.integrityHeads&&list.integrityHeads.events&&list.integrityHeads.repair);
 assert.deepEqual(list.integrityHeads,f.store.integrityHeads());
 assert.equal(list.integrity,undefined);
 const audited=await handler('workflow_status',{verifyIntegrity:true});
 assert.ok(audited.integrity);
 assert.equal(typeof audited.integrity.events.verified,'boolean');
 assert.equal(typeof audited.integrity.repair.verified,'boolean');
 assert.deepEqual(audited.integrity,f.store.verifyIntegrity());
 const source=await start(f.engine,broken);
 assert.equal(source.status,'failed');
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
