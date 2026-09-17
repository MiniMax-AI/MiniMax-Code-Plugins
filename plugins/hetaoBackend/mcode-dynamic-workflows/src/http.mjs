import {assertValidDependencies} from './dependencies.mjs';
import {createHash} from 'node:crypto';
import {exportReport,REPORT_STYLES} from './reports.mjs';
import http from 'node:http';
import { resolveMcode } from './availability.mjs';
import { readFile } from 'node:fs/promises';
import { check } from './common.mjs';
import { previewTopology } from './topology.mjs';
import { waitEvents,createToolHandler } from './tools.mjs';
export async function startHTTP(engine,{port=0,webRoot=new URL('../web/',import.meta.url),exampleRoot=new URL('../examples/',import.meta.url)}={}){
 const reportStyleHash=createHash('sha256').update(REPORT_STYLES).digest('base64');
 let origin;
 const sockets=new Set();
 const server=http.createServer(async(req,res)=>{
   const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
   try{
    check(req.headers.host===new URL(origin).host,'无效 Host');if(req.headers.origin)check(req.headers.origin===origin,'禁止跨站请求');
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      // A custom header forces cross-origin browser requests through a denied CORS preflight.
      if(req.headers['x-workflow-client']!=='1'||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return json({error:'请从本地 Workflow Studio 面板访问。'},403);
      if(req.method==='GET'&&url.pathname==='/api/config')return json({serviceProtocol:2,features:{workflowRepair:true},pid:process.pid,workspace:engine.options.workspace,executor:engine.options.command,defaults:engine.defaults,scheduler:engine.schedulerStatus(),mcodeAvailable:!!(await resolveMcode(engine.options.command??'mcode')),example:await readFile(new URL('audit.js',exampleRoot),'utf8')});
      if(req.method==='GET'&&url.pathname==='/api/templates')return json(engine.store.templates().map(({definition,...t})=>({...t,objective:definition.metadata?.objective??''})));
      const template=url.pathname.match(/^\/api\/templates\/([a-f0-9-]+)$/);
      if(template&&req.method==='GET'){const value=engine.store.template(template[1]);check(value,'模板不存在');return json(value);}
      const report=url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/report$/);
      if(report&&req.method==='GET'){const run=engine.snapshot(report[1]),file=exportReport(run,run.steps,{format:url.searchParams.get('format')??'html',language:url.searchParams.get('language')??'en'});res.writeHead(200,{'Content-Type':file.contentType,'Content-Disposition':`attachment; filename="${file.filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(file.body);}
      if(req.method==='GET'&&url.pathname==='/api/scheduler')return json(engine.schedulerStatus());
      if(req.method==='GET'&&url.pathname==='/api/runs')return json(engine.store.list().map(({script,input,result,fingerprints,...r})=>r));
      const match=url.pathname.match(/^\/api\/runs\/([a-f0-9-]+)(?:\/(wait|pause|cancel|resume|edit|approve|repair))?$/);
      if(match&&req.method==='GET'){if(match[2]==='wait')return json(await waitEvents(engine,match[1],Math.max(0,Number(url.searchParams.get('after'))||0),20000));return json(engine.snapshot(match[1]));}
      if(req.method==='POST'){
       check(req.headers['content-type']?.startsWith('application/json'),'需要 application/json');req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;check(Buffer.byteLength(body)<=700_000,'请求过大');}const data=JSON.parse(body||'{}');
       if(url.pathname==='/api/templates')return json(engine.saveTemplate(data.runId,data),201);
       if(template){check(data.action==='delete','模板操作无效');check(engine.store.deleteTemplate(template[1]),'模板不存在');return json({deleted:true});}
       if(url.pathname==='/api/scheduler')return json(engine.configureScheduler(data));
       if(url.pathname==='/api/tools')return json(await createToolHandler(engine,()=>`${origin}/`)(data.name,data.arguments));
       if(url.pathname==='/api/validate')return json(assertValidDependencies(previewTopology(data.script)));
       if(url.pathname==='/api/runs')return json(await engine.start(data),201);
       if(match&&match[2]==='repair')return json(await engine.repair(match[1],data));
       if(match&&match[2]==='edit')return json(await engine.update(match[1],data));
       if(match&&match[2]==='approve')return json(await engine.approve(match[1],data));
       if(match&&match[2]==='resume')return json(await engine.resume(match[1],data));
       if(match&&['pause','cancel'].includes(match[2]))return json(await engine.stop(match[1],match[2]==='pause'?'paused':'cancelled'));
      }
      return json({error:'路由不存在'},404);
    }
    check(req.method==='GET','不支持的请求');const names={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/readable.css':'readable.css'};const name=names[url.pathname];if(!name){res.writeHead(404);return res.end();}
    const data=await readFile(new URL(name,webRoot));res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'sha256-${reportStyleHash}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(data);
   }catch(e){if(!res.headersSent)json({error:e.message},400);else res.end();}
 });server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
 return {url:`${origin}/`,server,close:()=>new Promise(r=>{server.close(r);for(const s of sockets)s.destroy();})};
}
