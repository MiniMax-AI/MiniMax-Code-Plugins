import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
// Fail-loud suite. Background evidence (2026-09-20, this machine): during a
// broken-CLI window (better-sqlite3 ABI break + mcode v0.2.4) three runs
// persisted run.started → run.finished(succeeded) in 42ms with attempts:0,
// steps:0, errorDetails:null and a valid topology containing planned agent
// nodes — a completely dead executor layer translated into success. These
// checks pin the opposite behavior through the same surfaces that lied:
// a PATH-injected dead CLI must fail the run with actionable details, a
// swallowed pre-dispatch failure must not finish as zero-step success, and a
// healthy CLI must not be blocked by the preflight. The zero-dispatch guard
// splits planned nodes into required (neither conditional nor dynamic per
// static analysis) and optional: zero dispatch over an optional-only plan is
// a legitimate branch outcome and succeeds, while any undispatched required
// node keeps the incident verdict — failed NO_AGENTS_EXECUTED.
const binary=resolve('dist/main.mjs');
const exec=promisify(execFile);
const brokenCliBody=`process.stderr.write('simulated broken CLI: native module ABI mismatch\\n');process.exit(1);`;
const healthyCliBody=`const a=process.argv.slice(2);
if(a.includes('--version')){process.stdout.write('mcode 0.9.0-failloud\\n');process.exit(0);}
process.stdout.write(JSON.stringify({schemaVersion:1,type:'exec.completed',result:{schemaVersion:1,type:'exec.result',status:'succeeded',output:{answer:'healthy'}}})+'\\n');`;
const execDeadCliBody=`const a=process.argv.slice(2);
if(a.includes('--version')){process.stdout.write('mcode 0.2.4-antique\\n');process.exit(0);}
process.stderr.write('simulated broken native module\\n');process.exit(1);`;
// Install a fake mcode that wins PATH resolution on both families: POSIX gets
// an executable shebang shim; win32 resolution requires a PATHEXT match plus
// a spawnable sibling node entry (mcode-layout rules from mcode-location).
async function pathShim(dir,body){
 await mkdir(dir,{recursive:true});
 if(process.platform==='win32'){
  await writeFile(join(dir,'mcode.cmd'),'@echo off\r\n');
  const entry=join(dir,'node_modules','@minimax-ai','code');
  await mkdir(entry,{recursive:true});
  await writeFile(join(entry,'cli.js'),body);
  await writeFile(join(entry,'package.json'),JSON.stringify({name:'@minimax-ai/code',version:'0.2.4'}));
  return;
 }
 await writeFile(join(dir,'mcode'),`#!/usr/bin/env node\n${body}`,{mode:0o755});
 await chmod(join(dir,'mcode'),0o755);
}
async function standaloneCli(body){
 const dir=await mkdtemp(join(tmpdir(),'wf-failloud-cli-'));
 const file=join(dir,'fake-cli.cjs');
 await writeFile(file,body);
 return {file,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
async function engineFixture(options={}){
 const dir=await mkdtemp(join(tmpdir(),'wf-failloud-'));
 const store=new Store(dir),engine=new Engine(store,{workspace:dir,runTimeoutMs:10000,...options});
 return {dir,store,engine,cleanup:async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
async function startRun(engine,request){
 const draft=await engine.start({name:'Fail loud',input:{},...request});
 return engine.approve(draft.id,{revision:draft.revision});
}
async function done(engine,id){for(let i=0;i<300;i++){const s=engine.snapshot(id);if(!engine.active.has(id))return s;await delay(20);}throw Error('test timeout');}
// Full service stack (MCP stdio → daemon → HTTP), with the daemon's
// environment pointed at the injected PATH shim and an empty install root so
// no real ~/.minimax-code or managed toolchain can leak into resolution.
async function serviceFixture(body){
 const dir=await mkdtemp(join(tmpdir(),'wf-failloud-service-'));
 const shim=join(dir,'shim'),install=join(dir,'empty-install');
 await pathShim(shim,body);await mkdir(install,{recursive:true});
 const shimPath=`${shim}${delimiter}${process.env.PATH??process.env.Path??''}`;
 // Set both spellings: win32 env keys are case-insensitive to readers, but a
 // spread copy can carry the original Path alongside an injected PATH.
 const env={...process.env,PATH:shimPath,Path:shimPath,MCODE_INSTALL_DIR:install};
 const client=new Client({name:'fail-loud',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--workspace',dir,'--data-dir',dir],env,stderr:'pipe'});
 await client.connect(transport);
 let url=null;for(let i=0;i<150;i++){try{url=JSON.parse(await readFile(join(dir,'endpoint.json'),'utf8')).url;break;}catch{await delay(80);}}
 const close=async()=>{
  await client.close().catch(()=>{});
  try{await exec(process.execPath,[binary,'--stop-service','--workspace',dir,'--data-dir',dir]);}catch{}
  await rm(dir,{recursive:true,force:true});
 };
 if(!url){await close();throw Error('service did not start');}
 const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);return JSON.parse(result.content[0].text);};
 return {dir,url,call,close};
}
const httpHeaders={'X-Workflow-Client':'1','Content-Type':'application/json'};

test('a dead CLI on PATH fails the run at approval with actionable details — never succeeds',async()=>{
 const f=await serviceFixture(brokenCliBody);try{
  const started=await f.call('workflow_start',{requestId:'fail-loud-broken',name:'Broken CLI',executor:'mcode',script:'return await ctx.agent({id:"a",prompt:"p"});'});
  const approve=await fetch(new URL(`/api/runs/${started.id}/approve`,f.url),{method:'POST',headers:httpHeaders,body:JSON.stringify({revision:started.revision})});
  assert.equal(approve.status,400);
  assert.match((await approve.json()).error,/MCode CLI 不可用/);
  const run=await(await fetch(new URL(`/api/runs/${started.id}`,f.url),{headers:httpHeaders})).json();
  assert.equal(run.status,'failed');
  assert.notEqual(run.status,'succeeded');
  assert.equal(run.errorDetails.code,'MCODE_PREFLIGHT_FAILED');
  assert.match(run.errorDetails.message,/退出码 1/);
  assert.match(run.errorDetails.stderr,/native module ABI mismatch/);
  assert.match(run.errorDetails.suggestion,/mcode --version/);
  assert.equal(run.attempts,0);
  assert.equal(run.steps.length,0);
  const status=await f.call('workflow_status',{runId:started.id});
  assert.equal(status.status,'failed');assert.equal(status.errorDetails.code,'MCODE_PREFLIGHT_FAILED');assert.equal(status.preflight.ok,false);
 }finally{await f.close();}
});
test('zero-expansion guard: a script that swallows a pre-dispatch failure cannot finish succeeded',async()=>{
 const f=await engineFixture();try{
  const run=await startRun(f.engine,{requestId:'fail-loud-zero',executor:'demo',script:`try{await ctx.agent({id:'a',prompt:'p',dependsOn:['ghost']});}catch(e){return{handled:true}}`});
  const end=await done(f.engine,run.id);
  assert.equal(end.status,'failed');
  assert.notEqual(end.status,'succeeded');
  assert.equal(end.errorDetails.code,'NO_AGENTS_EXECUTED');
  assert.equal(end.errorDetails.plannedAgentNodes,1);
  assert.equal(end.attempts,0);
  assert.equal(end.steps.length,0);
 }finally{await f.cleanup();}
});
test('legal zero-agent scripts are not implicated by the guard',async()=>{
 const f=await engineFixture();try{
  const run=await startRun(f.engine,{requestId:'fail-loud-legal-zero',executor:'demo',script:'return {summary:"no agents needed"};'});
  const end=await done(f.engine,run.id);
  assert.equal(end.status,'succeeded');
  assert.equal(end.errorDetails,null);
  assert.equal(end.steps.length,0);
 }finally{await f.cleanup();}
});
test('a conditional agent on an untaken branch is a legal zero-dispatch success',async()=>{
 const f=await engineFixture();try{
  const run=await startRun(f.engine,{requestId:'fail-loud-untaken-branch',executor:'demo',input:{run:false},script:`if(input.run){await ctx.agent({id:'opt',prompt:'p'});}\nreturn {skipped:input.run!==true};`});
  const end=await done(f.engine,run.id);
  // The contract allows conditional branches not to run: static analysis
  // marks the node conditional, the runtime took the skip path, and the run
  // must finish succeeded with zero dispatched steps — not NO_AGENTS_EXECUTED.
  const node=end.topology.nodes.find(n=>n.stepId==='opt');
  assert.equal(node?.kind,'agent');
  assert.equal(node?.conditional,true);
  assert.equal(node?.dynamic,false);
  assert.equal(end.status,'succeeded',end.error);
  assert.equal(end.errorDetails,null);
  assert.equal(end.steps.length,0);
  assert.deepEqual(end.result,{skipped:true});
 }finally{await f.cleanup();}
});
test('a mixed plan with an undispatched required agent still fails NO_AGENTS_EXECUTED',async()=>{
 const f=await engineFixture();try{
  const run=await startRun(f.engine,{requestId:'fail-loud-mixed',executor:'demo',input:{run:false},script:`if(input.run){await ctx.agent({id:'opt',prompt:'p'});}\ntry{await ctx.agent({id:'req',prompt:'p',dependsOn:['ghost2']});}catch(e){}\nreturn {handled:true};`});
  const end=await done(f.engine,run.id);
  // The conditional node legitimately did not run, but the required node's
  // dependency error was swallowed — the incident shape. One undispatched
  // required node is enough to fail the run.
  const conditional=end.topology.nodes.find(n=>n.stepId==='opt');
  const required=end.topology.nodes.find(n=>n.stepId==='req');
  assert.equal(conditional?.conditional,true);
  assert.equal(required?.conditional,false);
  assert.equal(required?.dynamic,false);
  assert.equal(end.status,'failed');
  assert.notEqual(end.status,'succeeded');
  assert.equal(end.errorDetails.code,'NO_AGENTS_EXECUTED');
  assert.equal(end.errorDetails.plannedAgentNodes,2);
  assert.equal(end.errorDetails.requiredAgentNodes,1);
  assert.equal(end.steps.length,0);
 }finally{await f.cleanup();}
});
test('a dynamic node whose runtime collection is empty is a legal zero-dispatch success',async()=>{
 const f=await engineFixture();try{
  const run=await startRun(f.engine,{requestId:'fail-loud-dynamic-empty',executor:'demo',input:{tasks:[]},script:`for(const t of input.tasks??[]){await ctx.agent({id:'task-'+t,prompt:'p'});}\nreturn {dispatched:0};`});
  const end=await done(f.engine,run.id);
  // Static analysis marks loop-backed, non-literal-id nodes dynamic: the
  // dispatch count is unknowable in advance, so zero iterations over an
  // empty collection is a legitimate outcome, not a swallowed failure.
  const node=end.topology.nodes.find(n=>n.kind==='agent');
  assert.ok(node,'topology plans the dynamic agent node');
  assert.equal(node.dynamic,true);
  assert.equal(node.conditional,false);
  assert.equal(end.status,'succeeded',end.error);
  assert.equal(end.errorDetails,null);
  assert.equal(end.steps.length,0);
  assert.deepEqual(end.result,{dispatched:0});
 }finally{await f.cleanup();}
});
test('preflight passes a healthy CLI and the run succeeds with a readable health field',async()=>{
 const cli=await standaloneCli(healthyCliBody);try{
  const f=await engineFixture({command:process.execPath,args:[cli.file]});try{
   const run=await startRun(f.engine,{requestId:'fail-loud-healthy',executor:'mcode',script:'return await ctx.agent({id:"a",prompt:"p"});'});
   const end=await done(f.engine,run.id);
   assert.equal(end.status,'succeeded',end.error);
   assert.equal(end.steps[0].status,'succeeded');
   assert.equal(end.result.status,'succeeded');
   assert.deepEqual(end.result.output,{answer:'healthy'});
   assert.equal(end.preflight.ok,true);
   assert.equal(end.preflight.probe,'--version');
   assert.equal(end.preflight.version,'mcode 0.9.0-failloud');
  }finally{await f.cleanup();}
 }finally{await cli.cleanup();}
});
test('an executor that passes the probe but dies on every dispatch fails the run with the sample',async()=>{
 const cli=await standaloneCli(execDeadCliBody);try{
  const f=await engineFixture({command:process.execPath,args:[cli.file]});try{
   const run=await startRun(f.engine,{requestId:'fail-loud-execdead',executor:'mcode',script:'const r=await ctx.agent({id:"a",prompt:"p"});return {agentStatus:r.status};'});
   const end=await done(f.engine,run.id);
   assert.equal(end.status,'failed');
   assert.equal(end.steps[0].status,'failed');
   assert.equal(end.steps[0].errorDetails.code,'MCODE_MISSING_RESULT');
   assert.equal(end.errorDetails.code,'MCODE_MISSING_RESULT');
   assert.match(end.errorDetails.message,/native module/);
  }finally{await f.cleanup();}
 }finally{await cli.cleanup();}
});
