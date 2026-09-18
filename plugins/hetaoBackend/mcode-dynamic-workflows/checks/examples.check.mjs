import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.mjs';import {Engine} from '../src/engine.mjs';import {validateScript} from '../src/common.mjs';
async function fixture(execute){const dir=await mkdtemp(join(tmpdir(),'wf-examples-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir,execute});return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};}
async function finish(engine,id){for(let i=0;i<300;i++){if(!engine.active.has(id))return engine.snapshot(id);await delay(20);}throw Error('timeout');}
test('reflection example: independent agents each receive the original task and material (input contract)',async()=>{
 const script=(await readFile('examples/reflection.js','utf8'));
 assert.deepEqual(validateScript(script),{valid:true,scriptHash:validateScript(script).scriptHash,dslVersion:1});
 const inputs=[];const f=await fixture(async s=>{inputs.push({id:s.id,input:s.input});return {output:{text:`${s.id} text`,openIssues:[]}};});
 try{
  const started=await f.engine.start({requestId:crypto.randomUUID(),name:'Reflection example',executor:'demo',script,input:{task:'write a release note',material:'changelog.md contents'}});
  await f.engine.approve(started.id,{revision:1});const end=await finish(f.engine,started.id);
  assert.equal(end.status,'succeeded',end.error);
  const by={};for(const {id,input} of inputs)by[id]=input;
  for(const id of ['draft','critique','revise'])assert.ok(by[id],`${id} executed`);
  for(const id of ['draft','critique','revise']){assert.equal(by[id].task,'write a release note',`${id} gets the original task`);assert.equal(by[id].material,'changelog.md contents',`${id} gets the original material`);}
  assert.ok(by.critique.draft,'critique sees the draft');assert.equal(by.critique.draft.text,'draft text');
  assert.ok(by.revise.draft&&by.revise.critique,'revision sees draft and critique');
  assert.ok(by.revise.critique.text==='critique text','revision can independently check the critique against the source');
  assert.deepEqual(end.result,{text:'revise text',openIssues:[],critiqueCount:0});
 }finally{await f.cleanup();}
});
