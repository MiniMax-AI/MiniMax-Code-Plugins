import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {preflightMcode} from '../src/availability.mjs';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
// Preflight tree-cleanup regressions (PR #57 review). The old probe killed
// only the root with SIGKILL and then waited for `close`; descendants that
// inherited the probe's stdout/stderr pipes could withhold that event forever,
// so engine.approve() could hang past the advertised watchdog and the tree
// leaked. These checks pin the bounded, tree-aware contract through real
// descendants on POSIX and through injected stopTree fakes for the win32
// failure shapes (same convention as the taskkill tests in
// process-tree.check.mjs; real Windows evidence comes from fork preview):
// a timed-out probe with pipe-holding descendants, a descendant that ignores
// graceful termination, a cleanup that fails or never confirms, and an
// approve() that must settle within a fixed deadline.
const CLEANUP_BUDGET_MS=5000; // must mirror src/availability.mjs
// A fake `mcode` whose --version never exits and which spawns a descendant
// holding the inherited stdout/stderr pipes — the exact shape that withheld
// `close` from the old root-only kill. The 15s self-exit keeps the suite
// leak-free even if a regression reintroduces an unbounded path.
async function cliFixture({ignoreTerm=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'wf-preflight-cli-'));
 const ticks=join(dir,'ticks'),pids=join(dir,'pids'),script=join(dir,'cli.cjs');
 const descendant=`const fs=require('node:fs');${ignoreTerm?"process.on('SIGTERM',()=>{});":''}
    let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),20);
    setTimeout(()=>process.exit(0),15000);`;
 await writeFile(script,`const cp=require('node:child_process'),fs=require('node:fs'),a=process.argv.slice(2);
    if(!a.includes('--version'))process.exit(0);
    process.stderr.write('preflight fixture: --version hangs by design\\n');
    const d=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,d.pid]));
    setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000);`);
 const probe=(timeoutMs=1500,extra={})=>preflightMcode(process.execPath,{args:[script],timeoutMs,...extra});
 const ready=async()=>{for(let i=0;i<250;i++){try{if(Number(await readFile(ticks,'utf8'))>0)return;}catch{}await delay(20);}throw Error('descendant did not start');};
 const stopped=async()=>{const before=await readFile(ticks,'utf8');await delay(150);assert.equal(await readFile(ticks,'utf8'),before,'descendant kept running after the probe settled');};
 const cleanup=async()=>{
  // Fixtures stay bounded even when the code under test regresses: kill the
  // recorded tree explicitly before removing the temp data (the pids file
  // appears only after the descendant has spawned).
  let recorded=null;for(let i=0;i<100;i++){try{recorded=JSON.parse(await readFile(pids,'utf8'));break;}catch{await delay(20);}}
  for(const pid of recorded??[]){try{process.kill(pid,'SIGKILL');}catch{}}
  await delay(50);await rm(dir,{recursive:true,force:true});
 };
 return {script,probe,ready,stopped,cleanup};
}
test('a timed-out probe with pipe-inheriting descendants settles bounded and leaks nothing',async()=>{
 const f=await cliFixture();const t0=Date.now();let p;
 try{p=f.probe(1500);await f.ready();
  const result=await p;
  assert.equal(result.ok,false);
  assert.equal(result.code,'MCODE_PREFLIGHT_FAILED');
  assert.match(result.message,/探测超时/);
  assert.doesNotMatch(result.message,/无法确认/);
  assert.equal(result.cleanupConfirmed,true);
  assert.match(result.stderr,/hangs by design/);
  const elapsed=Date.now()-t0;
  assert.ok(elapsed<1500+CLEANUP_BUDGET_MS+3000,`probe took ${elapsed}ms`);
  await f.stopped();
 }finally{await f.cleanup();await p.catch(()=>{});}
});
test('descendants ignoring graceful termination still converge on a bounded verdict',{skip:process.platform==='win32'},async()=>{
 const f=await cliFixture({ignoreTerm:true});const t0=Date.now();let p;
 try{p=f.probe(1500);await f.ready();
  const result=await p;
  assert.equal(result.ok,false);
  assert.equal(result.code,'MCODE_PREFLIGHT_FAILED');
  // The descendant ignores SIGTERM, so the cleanup must either escalate to
  // SIGKILL (probe-timeout verdict, tree verifiably stopped) or fail closed
  // as cleanup-unconfirmed. Both legal paths are bounded.
  if(result.message.includes('无法确认')){assert.match(result.message,/无法确认进程树已停止/);assert.equal(result.cleanupConfirmed,false);}
  else{assert.match(result.message,/探测超时/);assert.equal(result.cleanupConfirmed,true);await f.stopped();}
  const elapsed=Date.now()-t0;
  assert.ok(elapsed<1500+CLEANUP_BUDGET_MS+3000,`probe took ${elapsed}ms`);
 }finally{await f.cleanup();await p.catch(()=>{});}
});
test('cleanup failure fails closed as MCODE_PREFLIGHT_FAILED with the reason',async()=>{
 const f=await cliFixture();let p;
 try{p=f.probe(400,{stopTree:async()=>({confirmed:false,reason:'Access denied (taskkill shape)'})});
  const result=await p;
  assert.equal(result.ok,false);
  assert.equal(result.code,'MCODE_PREFLIGHT_FAILED');
  assert.match(result.message,/无法确认进程树已停止/);
  assert.match(result.message,/Access denied/);
  assert.equal(result.cleanupConfirmed,false);
 }finally{await f.cleanup();await p.catch(()=>{});}
});
test('a cleanup that never confirms is abandoned within the independent budget',async()=>{
 const f=await cliFixture();const t0=Date.now();let p;
 try{p=f.probe(400,{stopTree:()=>new Promise(()=>{})});
  const result=await p;
  assert.equal(result.ok,false);
  assert.equal(result.code,'MCODE_PREFLIGHT_FAILED');
  assert.match(result.message,/无法确认进程树已停止/);
  assert.match(result.message,/清理预算/);
  const elapsed=Date.now()-t0;
  assert.ok(elapsed>=400+CLEANUP_BUDGET_MS-1500,`settled too early: ${elapsed}ms`);
  assert.ok(elapsed<400+CLEANUP_BUDGET_MS+2000,`settled too late: ${elapsed}ms`);
 }finally{await f.cleanup();await p.catch(()=>{});}
});
test('approve settles within a fixed deadline when the probe hangs; the run fails and never sticks in approving',async()=>{
 const f=await cliFixture();
 const dir=await mkdtemp(join(tmpdir(),'wf-preflight-engine-'));
 const store=new Store(dir),engine=new Engine(store,{workspace:dir,command:process.execPath,args:[f.script],preflightTimeoutMs:600});
 try{
  const draft=await engine.start({requestId:'preflight-tree-approve',name:'Preflight tree',executor:'mcode',script:'return await ctx.agent({id:"a",prompt:"p"});'});
  const approve=engine.approve(draft.id,{revision:draft.revision});
  // Deadline = injected probe timeout + cleanup budget + margin — well under
  // the advertised 20s default watchdog, and a hang (the regression under
  // test) rejects here instead of stalling the approval API forever.
  const deadline=600+CLEANUP_BUDGET_MS+4000;
  let watchdog;
  const bounded=Promise.race([approve,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error(`approve 未在 ${deadline}ms 内返回`)),deadline);watchdog.unref();})]);
  await assert.rejects(bounded,/MCode CLI 不可用/);
  clearTimeout(watchdog);
  const snap=engine.snapshot(draft.id);
  assert.equal(snap.status,'failed');
  assert.equal(snap.errorDetails.code,'MCODE_PREFLIGHT_FAILED');
  assert.match(snap.errorDetails.message,/探测超时|无法确认/);
  assert.equal(snap.preflight.ok,false);
  assert.equal(snap.attempts,0);
  assert.equal(snap.steps.length,0);
  assert.equal(engine.approving.has(draft.id),false);
  await Promise.race([approve.catch(()=>{}),delay(500)]);
 }finally{await engine.close();store.close();await rm(dir,{recursive:true,force:true});await f.cleanup();}
});
