import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,rm,readFile,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
const binary=resolve('dist/main.mjs');
const exec=promisify(execFile),headers={'X-Workflow-Client':'1','Content-Type':'application/json'},sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'wf-lifetime-')),clients=[];
 const args=['--workspace',dir,'--data-dir',dir];
 const connect=async()=>{const client=new Client({name:'lifetime',version:'1'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[binary,'--stdio',...args],stderr:'pipe'}));return client;};
 const endpoint=async()=>JSON.parse(await readFile(join(dir,'endpoint.json'),'utf8'));
 const stop=()=>exec(process.execPath,[binary,'--stop-service',...args]);
 const close=async()=>{for(const c of clients)await c.close();try{const e=await endpoint();const list=await(await fetch(new URL('/api/runs',e.url),{headers})).json();for(const r of list)if(['running','queued','pausing','stopping'].includes(r.status))await fetch(new URL(`/api/runs/${r.id}/cancel`,e.url),{method:'POST',headers,body:'{}'});}catch{}await stop();await rm(dir,{recursive:true,force:true});};
 return {dir,args,connect,endpoint,stop,close};
}
test('concurrent chats share one daemon; execution survives disconnect and restart preserves URL and data',async()=>{
 const f=await fixture();try{
  const [a,b]=await Promise.all([f.connect(),f.connect()]);
  const call=async(c,name,args={})=>{const result=await c.callTool({name,arguments:args});assert.ok(!result.isError,result.content[0].text);return JSON.parse(result.content[0].text);};
  const first=await f.endpoint(),dashboard=await call(a,'workflow_dashboard');
  assert.equal(new URL(dashboard.url).hash,'');assert.equal((await call(b,'workflow_dashboard')).url,dashboard.url);
  const draft=await call(a,'workflow_start',{requestId:'lifetime',name:'Continues after chat',executor:'demo',script:'await ctx.agent({id:"one",prompt:"p"}); return await ctx.agent({id:"two",prompt:"p"});'});
  await fetch(new URL(`/api/runs/${draft.id}/approve`,dashboard.url),{method:'POST',headers,body:JSON.stringify({revision:1})});
  await assert.rejects(f.stop(),e=>/活动工作流/.test(e.stderr));
  await a.close();await b.close();
  let run;for(let i=0;i<60;i++){run=await(await fetch(new URL(`/api/runs/${draft.id}`,dashboard.url),{headers})).json();if(run.status==='succeeded')break;await sleep(100);}
  assert.equal(run.status,'succeeded');assert.equal(run.steps.filter(s=>s.kind==='agent'&&s.status==='succeeded').length,2);
  assert.equal((await f.endpoint()).pid,first.pid);
  await f.stop();assert.equal((await f.endpoint()).url,first.url);
  // Legacy owners remove their discovery file. The saved address must still survive.
  await unlink(join(f.dir,'endpoint.json'));
  const c=await f.connect();const restarted=await f.endpoint();assert.equal(restarted.url,first.url);assert.notEqual(restarted.pid,first.pid);
  assert.equal((await call(c,'workflow_status',{runId:draft.id})).status,'succeeded');
 }finally{await f.close();}
});
test('occupied saved port fails explicitly instead of moving the dashboard',async()=>{
 const f=await fixture();let listener;try{
  const a=await f.connect(),first=await f.endpoint();await a.close();await f.stop();
  listener=net.createServer();await new Promise((r,j)=>{listener.once('error',j);listener.listen(Number(new URL(first.url).port),'127.0.0.1',r);});
  await assert.rejects(exec(process.execPath,[binary,...f.args]),e=>/EADDRINUSE/.test(e.stderr));
  assert.equal((await f.endpoint()).url,first.url);
 }finally{if(listener)await new Promise(r=>listener.close(r));await f.close();}
});

test('new repair tools report an old daemon explicitly without sending unsupported calls or stopping it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-old-repair-'));let calls=0;const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/config')res.end(JSON.stringify({workspace:dir,pid:process.pid}));else{calls++;res.end('{}');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/`;await writeFile(join(dir,'endpoint.json'),JSON.stringify({pid:process.pid,url,workspace:dir}));const client=new Client({name:'old-service',version:'1'});
 try{await client.connect(new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--workspace',dir,'--data-dir',dir],stderr:'pipe'}));
 for(const [name,args] of [['workflow_repair',{}],['workflow_results',{runId:'old',includeDefinition:true}]]){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);assert.match(result.content[0].text,/WORKFLOW_SERVICE_UPGRADE_REQUIRED/);assert.match(result.content[0].text,/--stop-service/);}
 assert.equal(calls,0);assert.equal((await fetch(new URL('/api/config',url))).status,200);
 }finally{await client.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
