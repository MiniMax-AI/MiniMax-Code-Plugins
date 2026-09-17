import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

function populate(store){
 const save=(id,status)=>store.save({id,requestId:id,requestHash:id,status,name:id});
 for(const status of ['running','queued','pausing','stopping'])save('old-'+status,status);
 for(let i=0;i<105;i++)save('draft-'+i,'pending_review');
}

test('recent-run listing retains active runs older than its history window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-history-'));const store=new Store(dir);
 try{
  populate(store);const runs=store.list();assert.equal(runs.length,100);
  for(const status of ['running','queued','pausing','stopping'])assert.ok(runs.some(r=>r.id==='old-'+status));
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('restart recovers unfinished runs beyond the recent history window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-recovery-'));let store=new Store(dir);
 try{
  populate(store);store.close();store=new Store(dir);
  for(const status of ['running','queued','pausing','stopping']){
   const run=store.get('old-'+status);assert.equal(run.status,'needs_attention');assert.match(run.error,/确认旧 Agent 已停止/);
   assert.ok(store.list().some(r=>r.id===run.id));
  }
  assert.equal(store.get('draft-104').status,'pending_review');
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('losing the discovery lockfile cannot create two live state owners',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-ownership-'));let store=new Store(dir),unexpected;
 try{
  store.save({id:'live',requestId:'live',requestHash:'live',status:'running'});
  // Represents a second starter unlinking a lock it previously read as stale.
  await unlink(join(dir,'owner.lock'));
  assert.throws(()=>{unexpected=new Store(dir);},/locked/);
  assert.equal(store.get('live').status,'running');
  store.saveSetting('still-owned',true);assert.equal(store.setting('still-owned'),true);
  store.close();store=new Store(dir);assert.equal(store.get('live').status,'needs_attention');
 }finally{unexpected?.close();store.close();await rm(dir,{recursive:true,force:true});}
});
