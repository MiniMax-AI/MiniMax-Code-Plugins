import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {canonicalWorkspace,projectDataDir} from '../src/workspace-router.mjs';
const binary=resolve('dist/main.mjs'),pluginRoot=resolve('.');
const headers={'X-Workflow-Client':'1','Content-Type':'application/json'};
const exec=promisify(execFile);
async function value(client,name,args={}){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text);}
test('project paths must exist, be absolute and cannot resolve into the plugin package',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wf-paths-'));
 try{
  await mkdir(join(root,'package'));await mkdir(join(root,'package','nested'));await mkdir(join(root,'package','..inside'));await writeFile(join(root,'file'),'x');
  for(const path of [undefined,'','relative'])await assert.rejects(canonicalWorkspace(path,join(root,'package')),/WORKSPACE_REQUIRED/);
  for(const path of [join(root,'missing'),join(root,'file')])await assert.rejects(canonicalWorkspace(path,join(root,'package')),/WORKSPACE_INVALID/);
  for(const path of [join(root,'package'),join(root,'package','nested'),join(root,'package','..inside')])await assert.rejects(canonicalWorkspace(path,join(root,'package')),/WORKSPACE_PLUGIN_ROOT/);
  await symlink(join(root,'package'),join(root,'alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(canonicalWorkspace(join(root,'alias'),join(root,'package')),/WORKSPACE_PLUGIN_ROOT/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('packaged MCP launched in plugin root routes concurrent projects and executes in the requested cwd',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'wf-project-routing-'))),dataRoot=join(root,'data');
 const projects=[join(root,'project one'),join(root,'project-two')];for(const dir of projects)await mkdir(dir);
 const alias=join(root,'alias');await symlink(projects[0],alias,process.platform==='win32'?'junction':'dir');
 const fake=join(root,'fake-cli.mjs');
 await writeFile(fake,`for await (const chunk of process.stdin) {}\nprocess.stdout.write(JSON.stringify({schemaVersion:1,type:'exec.completed',result:{schemaVersion:1,type:'exec.result',status:'succeeded',output:{cwd:process.cwd(),arg:process.argv[process.argv.indexOf('--cwd')+1]}}})+'\\n');`);
 const clients=[];
 async function connect(){const client=new Client({name:'project-test',version:'1'});clients.push(client);await client.connect(new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--data-dir',dataRoot,'--mcode-script',fake],cwd:pluginRoot,stderr:'pipe'}));return client;}
 try{
  const a=await connect();const tools=(await a.listTools()).tools;
  assert.equal(tools.length,11);for(const tool of tools.filter(t=>t.name!=='workflow_validate'))assert.ok(tool.inputSchema.required.includes('workspace'));
  await value(a,'workflow_validate',{script:'return 1;'});
  assert.equal((await a.callTool({name:'workflow_dashboard',arguments:{}})).isError,true);
  await assert.rejects(readdir(dataRoot),{code:'ENOENT'});
  await mkdir(dataRoot,{recursive:true});await writeFile(join(dataRoot,'endpoint.json'),JSON.stringify({pid:process.pid,url:'http://127.0.0.1:1/',workspace:pluginRoot}));
  const dashboards=await Promise.all(projects.map(workspace=>value(a,'workflow_dashboard',{workspace})));
  assert.notEqual(dashboards[0].url,dashboards[1].url);assert.deepEqual(dashboards.map(d=>d.workspace),projects);
  const b=await connect();const sameProject=await Promise.all([value(b,'workflow_dashboard',{workspace:alias}),value(b,'workflow_dashboard',{workspace:projects[0]})]);assert.ok(sameProject.every(d=>d.url===dashboards[0].url));
  const drafts=await Promise.all(projects.map(workspace=>value(a,'workflow_start',{workspace,requestId:'same-id',name:'Workspace binding',executor:'mcode',script:'return await ctx.agent({id:"cwd",prompt:"report cwd"});'})));
  assert.notEqual(drafts[0].id,drafts[1].id);assert.deepEqual(drafts.map(d=>d.workspace),projects);
  for(let i=0;i<2;i++){
   assert.equal((await fetch(new URL(`/api/runs/${drafts[i].id}/approve`,dashboards[i].url),{method:'POST',headers,body:JSON.stringify({revision:1})})).status,200);
   let status;
   for(let n=0;n<30;n++){status=await value(a,'workflow_wait',{workspace:projects[i],runId:drafts[i].id,timeoutMs:500,afterSequence:status?.nextSequence??0});if(status.status==='succeeded')break;}
   assert.equal(status.status,'succeeded');
   const results=await value(a,'workflow_results',{workspace:projects[i],runId:drafts[i].id});
   assert.deepEqual(results.steps.find(s=>s.id==='cwd').output,{cwd:projects[i],arg:projects[i]});
  }
  assert.equal((await a.callTool({name:'workflow_resume',arguments:{workspace:projects[1],runId:drafts[0].id}})).isError,true);
  assert.deepEqual((await value(a,'workflow_status',{workspace:projects[1]})).map(r=>r.id),[drafts[1].id]);
  await a.close();await b.close();
  for(let i=0;i<2;i++){
   const path=projectDataDir(dataRoot,projects[i]);await exec(process.execPath,[binary,'--stop-service','--workspace',projects[i],'--data-dir',path]);
  }
  const c=await connect();
  assert.equal((await value(c,'workflow_dashboard',{workspace:projects[0]})).url,dashboards[0].url);
  assert.equal((await value(c,'workflow_status',{workspace:projects[0],runId:drafts[0].id})).status,'succeeded');
 }finally{
  for(const c of clients)await c.close();
  for(const workspace of projects){const dir=projectDataDir(dataRoot,workspace);try{await readFile(join(dir,'endpoint.json'));await exec(process.execPath,[binary,'--stop-service','--workspace',workspace,'--data-dir',dir]);}catch(e){if(e.code!=='ENOENT')throw e;}}
  await rm(root,{recursive:true,force:true});
 }
});
