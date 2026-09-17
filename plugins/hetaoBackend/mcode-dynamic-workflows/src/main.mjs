import { parseArgs } from 'node:util';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readFile,writeFile,mkdir,open,rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { startHTTP } from './http.mjs';
import { startStdio } from './tools.mjs';
import {createWorkspaceRouter,PROJECT_TOOLS} from './workspace-router.mjs';
const {values}=parseArgs({options:{stdio:{type:'boolean'},'stop-service':{type:'boolean'},settings:{type:'string'},workspace:{type:'string'},'data-dir':{type:'string'},port:{type:'string'},'mcode-script':{type:'string'},'worker-config':{type:'string'}}});
const settings=values.settings?JSON.parse(await readFile(resolve(values.settings),'utf8')):{};
for(const key of Object.keys(settings))if(!['workspace','dataDir'].includes(key)||typeof settings[key]!=='string')throw Error('settings 只允许 workspace/dataDir 字符串');
if(values.port!==undefined&&(!/^\d+$/.test(values.port)||Number(values.port)>65535))throw Error('port 必须是 0–65535 的整数');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
async function readJSON(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
if(values.stdio&&process.env.MCODE_WORKFLOW_CHILD==='1'){
 const mcp=await startStdio(async()=>{throw Error('工作流 worker 不可再次调度 workflow');},[]);
 process.stdin.once('end',()=>void mcp.close());
}else if(values.stdio&&!values.workspace&&!settings.workspace){
 if(values.port!==undefined)throw Error('项目路由模式不接受全局 --port；请通过 --workspace 启动固定项目服务');
 const router=createWorkspaceRouter({binary:fileURLToPath(import.meta.url),pluginRoot:fileURLToPath(new URL('../',import.meta.url)),dataRoot:resolve(values['data-dir']??settings.dataDir??`${homedir()}/.mcode-dynamic-workflows`),extraArgs:['mcode-script','worker-config'].flatMap(key=>values[key]===undefined?[]:['--'+key,resolve(values[key])])});
 const mcp=await startStdio((name,args)=>router.call(name,args),PROJECT_TOOLS);
 let closing=false;const close=async()=>{if(closing)return;closing=true;await router.close();await mcp.close();};
 process.stdin.once('end',()=>void close());process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
}else{
 if(!values.workspace&&!settings.workspace)throw Error('WORKSPACE_REQUIRED: 请通过 --workspace 或 settings.workspace 指定项目目录');
 const dataDir=resolve(values['data-dir']??settings.dataDir??`${homedir()}/.mcode-dynamic-workflows`),workspace=resolve(values.workspace??settings.workspace),endpointPath=join(dataDir,'endpoint.json'),addressPath=join(dataDir,'address.json');
 async function saveAddress(url){const temp=addressPath+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify({url,workspace}),{mode:0o600});await rename(temp,addressPath);}
 const headersFor=u=>u.hash?{Authorization:`Bearer ${u.hash.slice(1)}`,'Content-Type':'application/json'}:{'X-Workflow-Client':'1','Content-Type':'application/json'};
 async function existing(){
  const endpoint=await readJSON(endpointPath);if(!endpoint||!alive(endpoint.pid))return null;
  const u=new URL(endpoint.url);if(u.hostname!=='127.0.0.1'||u.protocol!=='http:')throw Error('无效服务地址');
  const res=await fetch(u.origin+'/api/config',{headers:headersFor(u),signal:AbortSignal.timeout(2000)});
  if(!res.ok)throw Error('既有服务无法连接；不会替换仍在运行的服务');
  const config=await res.json();
  if(config.workspace!==workspace)throw Error('既有服务绑定了不同工作区，请配置独立 data-dir');
  if(config.pid!==undefined&&config.pid!==endpoint.pid)throw Error('服务身份不匹配；请检查 endpoint.json');
  if(values.port&&Number(values.port)!==0&&Number(values.port)!==Number(u.port))throw Error('既有服务端口与 --port 不一致；请先停止服务再更改');
  // Older owners delete endpoint.json on exit; keep their port separately for upgrade continuity.
  await saveAddress(u.origin+'/');
  return {endpoint,u,config};
 }
 if(values['stop-service']){
  const service=await existing();
  if(service){
   const res=await fetch(service.u.origin+'/api/runs',{headers:headersFor(service.u)});if(!res.ok)throw Error('无法检查活动工作流');
   if((await res.json()).some(r=>['running','queued','pausing','stopping'].includes(r.status)))throw Error('存在活动工作流，请先在面板中暂停或取消，再停止服务');
   process.kill(service.endpoint.pid,'SIGTERM');
   for(let i=0;i<100&&alive(service.endpoint.pid);i++)await delay(50);
   if(alive(service.endpoint.pid))throw Error('服务尚未退出，请查看 service.log');
  }
  process.stdout.write('Workflow Studio service stopped. The dashboard address is preserved.\n');
 }else if(values.stdio){
  let service=await existing();
  if(!service){
   await mkdir(dataDir,{recursive:true,mode:0o700});
   const owner=await readJSON(join(dataDir,'owner.lock'));
   if(!alive(owner?.pid)){
    const log=await open(join(dataDir,'service.log'),'a',0o600);
    const args=[fileURLToPath(import.meta.url),'--workspace',workspace,'--data-dir',dataDir];
    for(const key of ['port','mcode-script','worker-config'])if(values[key]!==undefined)args.push('--'+key,key==='port'?values[key]:resolve(values[key]));
    const child=spawn(process.execPath,args,{cwd:workspace,detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
    let spawnError;child.once('error',e=>{spawnError=e;});child.unref();await log.close();
    await delay(50);if(spawnError)throw spawnError;
   }
   for(let i=0;i<100&&!service;i++){await delay(80);service=await existing();}
   if(!service)throw Error(`本地服务启动失败。上次端口可能被占用；不会自动更换地址。请查看 ${join(dataDir,'service.log')}`);
  }
  const mcp=await startStdio(async(name,args)=>{
   if((name==='workflow_repair'||(name==='workflow_results'&&args?.includeDefinition))&&!service.config.features?.workflowRepair)throw Error('WORKFLOW_SERVICE_UPGRADE_REQUIRED: 当前后台服务版本不支持脚本修复。退出聊天不会重启服务。请先暂停或取消活动工作流，使用新版插件的 --stop-service（相同 --workspace 和 --data-dir）停止此项目服务，再重新连接 MCP；端口和历史会保留。data-dir: '+dataDir);
   const res=await fetch(service.u.origin+'/api/tools',{method:'POST',headers:headersFor(service.u),body:JSON.stringify({name,arguments:args}),signal:AbortSignal.timeout(65000)});
   const v=await res.json();if(!res.ok)throw Error(v.error);return v;
  });
  // A chat owns only this transport. The service, workers and dashboard outlive it.
  process.stdin.once('end',()=>void mcp.close());
 }else{
  const previous=(await readJSON(endpointPath))??await readJSON(addressPath);
  if(previous?.workspace&&previous.workspace!==workspace)throw Error('状态目录绑定了不同工作区，请配置独立 data-dir');
  const port=Number(values.port??(previous?new URL(previous.url).port:0));
  if(previous&&values.port==='0')throw Error('已有固定端口；请省略 --port 以复用，或显式指定新的端口');
  const store=new Store(dataDir);let engine,panel;
  try{
   engine=new Engine(store,{workspace,command:values['mcode-script']?process.execPath:'mcode',args:values['mcode-script']?[resolve(values['mcode-script'])]:[],configPath:values['worker-config']?resolve(values['worker-config']):undefined});
   panel=await startHTTP(engine,{port});
   await saveAddress(panel.url);
   const temp=endpointPath+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify({pid:process.pid,url:panel.url,workspace,serviceProtocol:2}),{mode:0o600});await rename(temp,endpointPath);
  }catch(e){await engine?.close();await panel?.close();store.close();throw e;}
  process.stdout.write(`Workflow Studio: ${panel.url}\n`);
  let closing=false;async function close(){if(closing)return;closing=true;await engine.close();await panel.close();store.close();process.exitCode=0;}
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
 }
}
