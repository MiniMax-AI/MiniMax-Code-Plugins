import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../src/store.mjs';

const file='plugins/hetaoBackend/mcode-dynamic-workflows/src/store.mjs';
const reference=process.argv[2]??'6481e4a';
const source=execFileSync('git',['show',`${reference}:${file}`],{encoding:'utf8'});
const {Store:Baseline}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const rounds=5, count=1100;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const result={baseline:reference,events:count,rounds};
for(const [name,Constructor] of [['full_per_event',Baseline],['full_batched',Store]]){
 const times=[];
 for(let round=0;round<rounds;round++){
  const dir=mkdtempSync(join(tmpdir(),'wf-benchmark-'));let store;
  try{
   store=new Constructor(dir);
   assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous,2);
   const start=performance.now();
   for(let index=0;index<count;index++)store.event('benchmark','step.progress',{index});
   store.flushVolatile?.();
   times.push(Number((performance.now()-start).toFixed(3)));
   assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,count);
   assert.equal(store.verifyIntegrity().events.verified,true);
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
 }
 result[name]={milliseconds:times,median_ms:median(times)};
}
result.speedup=Number((result.full_per_event.median_ms/result.full_batched.median_ms).toFixed(2));
console.log(JSON.stringify(result,null,2));
