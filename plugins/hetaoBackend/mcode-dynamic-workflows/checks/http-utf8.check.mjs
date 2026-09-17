import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {startHTTP} from '../src/http.mjs';

test('HTTP preserves Chinese and emoji when a JSON string spans network chunks',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-utf8-')),store=new Store(dir),engine=new Engine(store,{workspace:dir}),panel=await startHTTP(engine);
 let req;
 try{
  const definition={requestId:'split-utf8',name:'中文工作流 🧭',executor:'demo',script:'return input;',input:{text:'保留原文 🌏'}};
  const bytes=Buffer.from(JSON.stringify(definition)),split=bytes.indexOf(Buffer.from('中'))+1;
  const firstChunk=new Promise(resolve=>panel.server.once('request',incoming=>incoming.once('data',resolve)));
  const response=new Promise((resolve,reject)=>{
   req=request(new URL('/api/runs',panel.url),{method:'POST',headers:{'Content-Type':'application/json','X-Workflow-Client':'1','Content-Length':bytes.length}},res=>{
    res.setEncoding('utf8');let text='';res.on('data',chunk=>text+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,text}));
   });req.on('error',reject);
  });
  req.write(bytes.subarray(0,split));
  // Wait for the server to receive the partial character; no timing assumption.
  await firstChunk;req.end(bytes.subarray(split));
  const result=await response;assert.equal(result.status,201,result.text);
  const run=JSON.parse(result.text);assert.equal(run.name,definition.name);assert.deepEqual(run.input,definition.input);
 }finally{req?.destroy();await engine.close();await panel.close();store.close();await rm(dir,{recursive:true,force:true});}
});
