import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
const root=fileURLToPath(new URL('../',import.meta.url)),binary=join(root,'dist/main.mjs');
const headers={'X-Workflow-Client':'1','Content-Type':'application/json'},exec=promisify(execFile);
test('packaged public MCP creates review drafts and repairs with reused results without npm dependencies', {timeout:30000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workflow-public-')),mcp=JSON.parse(await readFile(join(root,'mcp.json'),'utf8'));
 const modern=JSON.parse(await readFile(join(root,'.claude-plugin/plugin.json'),'utf8'));
 assert.deepEqual(modern.mcpServers,mcp.mcpServers);assert.equal(modern.skills[0],'./skills/dynamic-workflow/SKILL.md');
 const child=spawn(process.execPath,[...mcp.mcpServers['dynamic-workflows'].args,'--workspace',dir,'--data-dir',dir],{cwd:root,stdio:['pipe','pipe','pipe']});
 let serial=0,url,stderr='';const pending=new Map();child.stderr.on('data',b=>stderr+=b);
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const msg=JSON.parse(line),entry=pending.get(msg.id);if(!entry)return;pending.delete(msg.id);clearTimeout(entry.timer);if(msg.error)entry.reject(Error(JSON.stringify(msg.error)));else entry.resolve(msg.result);});
 const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`${method} timed out: ${stderr}`));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=async(name,args={})=>{const result=await request('tools/call',{name,arguments:args});assert.ok(!result.isError,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
 const post=async(path,value)=>{const r=await fetch(new URL(path,url),{method:'POST',headers,body:JSON.stringify(value)});assert.equal(r.status,200);return r.json();};
 const done=async id=>{for(let i=0;i<100;i++){const r=await call('workflow_status',{runId:id});if(!['running','queued'].includes(r.status))return r;await new Promise(r=>setTimeout(r,30));}throw Error('run did not finish');};
 try{
 await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'public-package-test',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 assert.equal((await request('tools/list')).tools.length,11);url=(await call('workflow_dashboard')).url;
 const script=`const a=await ctx.agent({id:'evidence',prompt:'demo evidence'});throw Error('Synthesis needs a guard');`;
 const original=await call('workflow_start',{requestId:'original',name:'Public demo',executor:'demo',script});assert.equal(original.status,'pending_review');assert.equal(original.attempts,0);
 await post(`/api/runs/${original.id}/approve`,{revision:1});assert.equal((await done(original.id)).status,'failed');
 const detail=await call('workflow_results',{runId:original.id,includeDefinition:true});assert.equal(detail.definition.script,script);
 const repaired=await call('workflow_repair',{runId:original.id,sourceUpdatedAt:detail.updatedAt,requestId:'repair',reason:'Guard synthesis',script:`return await ctx.agent({id:'evidence',prompt:'demo evidence'});`,reuseStepIds:['evidence']});assert.equal(repaired.status,'pending_review');assert.equal(repaired.steps.length,0);
 await post(`/api/runs/${repaired.id}/approve`,{revision:1});const end=await done(repaired.id);assert.equal(end.status,'succeeded');assert.equal(end.attempts,0);assert.equal(end.steps[0].reusedFrom.runId,original.id);assert.equal((await call('workflow_status',{runId:original.id})).status,'failed');
 }finally{
 if(url){try{const runs=await(await fetch(new URL('/api/runs',url),{headers})).json();for(const r of runs)if(['running','queued','pausing','stopping'].includes(r.status))await post(`/api/runs/${r.id}/cancel`,{});}catch{}}
 child.stdin.end();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('test closed'));}pending.clear();lines.close();
 await exec(process.execPath,[binary,'--stop-service','--workspace',dir,'--data-dir',dir],{timeout:10000});child.kill();await rm(dir,{recursive:true,force:true});
 }
});
