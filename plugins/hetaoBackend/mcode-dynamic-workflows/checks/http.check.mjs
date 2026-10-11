import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {REPORT_STYLES} from '../src/reports.mjs';import {Store} from '../src/store.mjs';import {Engine} from '../src/engine.mjs';import {startHTTP} from '../src/http.mjs';
import {parseEventCursor} from '../src/tools.mjs';
test('HTTP local-origin checks, validation, creation and durable state',async()=>{const dir=await mkdtemp(join(tmpdir(),'wf-http-'));const store=new Store(dir),engine=new Engine(store,{workspace:dir});const http=await startHTTP(engine);const u=new URL(http.url),headers={'X-Workflow-Client':'1','Content-Type':'application/json'};try{const config=await(await fetch(u.origin+'/api/config',{headers})).json();assert.equal(u.hash,'');const page=await fetch(u.origin+'/');const policy=page.headers.get('content-security-policy');assert.ok(policy.includes("style-src 'self' 'sha256-"+createHash('sha256').update(REPORT_STYLES).digest('base64')+"'"));assert.ok(!policy.includes("'unsafe-inline'"));assert.equal((await fetch(u.origin+'/readable.css')).status,200);assert.equal(config.serviceProtocol,2);assert.equal((await fetch(u.origin+'/api/runs',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status,403);assert.equal((await fetch(u.origin+'/api/runs',{method:'OPTIONS',headers:{Origin:'https://example.com','Access-Control-Request-Headers':'x-workflow-client'}})).headers.get('access-control-allow-origin'),null);assert.equal(config.scheduler.limit,8);assert.equal((await fetch(u.origin+'/api/scheduler',{method:'POST',headers,body:JSON.stringify({globalConcurrency:16})})).status,200);assert.equal(engine.globalConcurrency,16);assert.equal((await fetch(u.origin+'/api/scheduler',{method:'POST',headers,body:JSON.stringify({globalConcurrency:0})})).status,400);assert.equal(config.defaults.maxSteps,120);assert.equal(config.defaults.stepTimeoutMs,1800000);assert.equal(typeof config.mcodeAvailable,'boolean');assert.equal((await fetch(u.origin+'/api/runs')).status,403);assert.equal((await fetch(u.origin+'/api/runs',{headers:{...headers,Origin:'https://example.com'}})).status,400);const bad=await fetch(u.origin+'/api/validate',{method:'POST',headers,body:JSON.stringify({script:'await import("fs")'})});assert.equal(bad.status,400);const badDeps=await fetch(u.origin+'/api/validate',{method:'POST',headers,body:JSON.stringify({script:'await ctx.agent({id:"b",prompt:"p",dependsOn:42})'})});assert.equal(badDeps.status,400);assert.match((await badDeps.json()).error,/b.*dependsOn.*number/);const res=await fetch(u.origin+'/api/runs',{method:'POST',headers,body:JSON.stringify({requestId:'h',name:'HTTP',executor:'demo',script:'return {ok:true}'})});assert.equal(res.status,201);const r=await res.json();assert.ok(store.get(r.id));assert.equal(r.status,'pending_review');assert.equal(engine.active.size,0);const edit=await fetch(u.origin+`/api/runs/${r.id}/edit`,{method:'POST',headers,body:JSON.stringify({revision:1,script:'return {edited:true}'})});assert.equal((await edit.json()).revision,2);assert.equal((await fetch(u.origin+`/api/runs/${r.id}/approve`,{method:'POST',headers,body:JSON.stringify({revision:1})})).status,400);assert.equal((await fetch(u.origin+`/api/runs/${r.id}/approve`,{method:'POST',headers,body:JSON.stringify({revision:2})})).status,200);const snapshot=await fetch(u.origin+`/api/runs/${r.id}`,{headers});assert.equal(snapshot.status,200);}finally{await engine.close();await http.close();store.close();await rm(dir,{recursive:true,force:true});}});
test('HTTP workflow_wait rejects cursors the MCP schema already rejects',async()=>{
 // Illegal cursors must fail before any wait or DB query, not after one.
 assert.equal(parseEventCursor(undefined),0);
 assert.equal(parseEventCursor(''),0);
 assert.equal(parseEventCursor(null),0);
 assert.equal(parseEventCursor(0),0);
 assert.equal(parseEventCursor(7),7);
 assert.equal(parseEventCursor(Number.MAX_SAFE_INTEGER),Number.MAX_SAFE_INTEGER);
 // '0x10' is a valid integer representation (16) and intentionally accepted;
 // the guard rejects non-integers/negatives/out-of-range, not alternate radix.
 for(const bad of[true,false,[],[0],[1],{},-1,-0.5,'-1',0.5,1.5,'1.5','1e100',Number.MAX_SAFE_INTEGER+1,'Infinity','-Infinity','NaN','abc',' 1 2 ',1e100,Infinity,-Infinity,NaN])
  assert.throws(()=>parseEventCursor(bad),/等待参数无效/,`must reject ${String(bad)}`);
 const dir=await mkdtemp(join(tmpdir(),'wf-http-cursor-'));
 const store=new Store(dir),engine=new Engine(store,{workspace:dir});
 const http=await startHTTP(engine);
 const u=new URL(http.url),headers={'X-Workflow-Client':'1','Content-Type':'application/json'};
 try{
  const created=await fetch(u.origin+'/api/runs',{method:'POST',headers,body:JSON.stringify({requestId:'cursor',name:'Cursor',executor:'demo',script:'return {ok:true}'})});
  const run=await created.json();
  // Same matrix over a real listening server, including forms that only exist
  // as text on the wire (NaN/Infinity/fractional cannot be JSON numbers).
  for(const after of['-1','0.5','1.5','1e100','9007199254740992','Infinity','-Infinity','NaN','abc','%201%202%20']){
   const wait=await fetch(u.origin+`/api/runs/${run.id}/wait?after=${encodeURIComponent(after)}`,{headers});
   assert.equal(wait.status,400,`after=${after} must be rejected`);
   assert.match(await wait.text(),/等待参数无效/);
  }
  const missing=await fetch(u.origin+`/api/runs/${run.id}/wait`,{headers});
  assert.equal(missing.status,200);
  const open=await missing.json();
  assert.equal(Number.isSafeInteger(open.nextSequence)&&open.nextSequence>=0,true);
  for(const after of['0','1','9007199254740991']){
   const ok=await fetch(u.origin+`/api/runs/${run.id}/wait?after=${after}`,{headers});
   assert.equal(ok.status,200,`after=${after} must be accepted`);
   const body=await ok.json();
   assert.equal(Number.isSafeInteger(body.nextSequence),true);
  }
  // A rejected cursor must not have consumed events or touched the store.
  assert.equal(store.get(run.id).status,'pending_review');
  assert.equal(store.verifyIntegrity().events.verified,true);
 }finally{await engine.close();await http.close();store.close();await rm(dir,{recursive:true,force:true});}
});
