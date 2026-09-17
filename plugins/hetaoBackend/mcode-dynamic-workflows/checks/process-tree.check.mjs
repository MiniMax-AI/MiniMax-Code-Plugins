import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { stopProcessTree } from '../src/process-tree.mjs';
import { mcodeExecute } from '../src/executor.mjs';

async function fixture({ignoreTerm=false, inherited=false, exitParent=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'workflow-tree-'));
  const ticks=join(dir,'ticks'), trigger=join(dir,'trigger'), script=join(dir,'cli.mjs');
  const descendant=`const fs=require('node:fs');${ignoreTerm?"process.on('SIGTERM',()=>{});":''}
    let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(ticks)},String(++n)),20);
    setTimeout(()=>process.exit(0),12000);`;
  await writeFile(script,`import {spawn} from 'node:child_process';import fs from 'node:fs';
    const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${JSON.stringify(inherited?'inherit':'ignore')}});
    fs.writeFileSync(${JSON.stringify(join(dir,'pids'))},JSON.stringify([process.pid,child.pid]));
    process.stdout.write(JSON.stringify({schemaVersion:1,type:'exec.started',sessionId:'test',turnId:'1'})+'\\n');
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(trigger)}))process.stdout.write('invalid json\\n');},20);
    ${exitParent?'setTimeout(()=>process.exit(0),200);':''}
    setTimeout(()=>process.exit(0),12000);`);
  const controller=new AbortController();
  const start=(timeoutMs=30000)=>mcodeExecute({id:'test',prompt:'test'},{command:process.execPath,args:[script],workspace:dir,
    timeoutMs,maxSteps:1,signal:controller.signal,onEvent:()=>{}}).then(()=>({code:'unexpected success'}),e=>e.details);
  const ready=async()=>{for(let i=0;i<250;i++){try{if(Number(await readFile(ticks,'utf8'))>0)return;}catch{}await delay(20);}throw Error('descendant did not start');};
  const stopped=async()=>{const before=await readFile(ticks,'utf8');await delay(150);assert.equal(await readFile(ticks,'utf8'),before,'descendant continued writing after executor settled');};
  const cleanup=async()=>{
    controller.abort();
    // Fixtures are bounded even when the executor regresses. Explicitly clean
    // their recorded processes on assertion failure before removing temp data.
    try {for(const pid of JSON.parse(await readFile(join(dir,'pids'),'utf8'))){try{process.kill(pid,'SIGKILL');}catch{}}}catch{}
    await delay(50);await rm(dir,{recursive:true,force:true});
  };
  return {controller,start,ready,stopped,cleanup,trigger};
}

for(const inherited of [false,true]) test(`cancellation stops ordinary descendants (${inherited?'inherited':'ignored'} pipes)`,async()=>{
  const f=await fixture({inherited});let result;
  const sibling=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try{result=f.start();await f.ready();f.controller.abort();assert.equal((await result).code,'RUN_INTERRUPTED');await f.stopped();assert.equal(sibling.exitCode,null);assert.equal(sibling.signalCode,null);process.kill(sibling.pid,0);}
  finally{sibling.kill('SIGKILL');await f.cleanup();await result;}
});
test('escalation survives parent exit when descendants ignore SIGTERM',{skip:process.platform==='win32'},async()=>{
  const f=await fixture({ignoreTerm:true});let result;
  try{result=f.start();await f.ready();f.controller.abort();assert.equal((await result).code,'RUN_INTERRUPTED');await f.stopped();}
  finally{await f.cleanup();await result;}
});
test('malformed protocol stops the whole owned process group',async()=>{
  const f=await fixture();let result;
  try{result=f.start();await f.ready();await writeFile(f.trigger,'go');assert.equal((await result).code,'MCODE_PROTOCOL_ERROR');await f.stopped();}
  finally{await f.cleanup();await result;}
});
test('watchdog stops descendants holding pipes after parent exit',{skip:process.platform==='win32'},async()=>{
  const f=await fixture({inherited:true,exitParent:true,ignoreTerm:true});let result;
  try{result=f.start(1);await f.ready();assert.equal((await result).code,'AGENT_TIMEOUT');await f.stopped();}
  finally{await f.cleanup();await result;}
});
test('Windows cleanup targets only the owned tree and fails closed when taskkill fails',async()=>{
  const calls=[],child={pid:12345,exitCode:null,signalCode:null};
  assert.equal((await stopProcessTree(child,{platform:'win32',run:async(...args)=>calls.push(args)})).confirmed,true);
  assert.deepEqual(calls[0].slice(0,2),['taskkill.exe',['/PID','12345','/T','/F']]);
  assert.equal(calls[0][2].timeout,3000);
  const denied=await stopProcessTree(child,{platform:'win32',run:async()=>{throw Error('Access denied');}});
  assert.equal(denied.confirmed,false);assert.match(denied.reason,/Access denied/);
  const exited=await stopProcessTree({...child,exitCode:0},{platform:'win32',run:async()=>assert.fail('must not target an exited PID')});
  assert.equal(exited.confirmed,false);
});
test('unreadable process table is unconfirmed; zombies are not executing descendants',async()=>{
  const child={pid:12345};
  for(const run of [async()=>{throw Error('ps unavailable');},async()=>({stdout:'unexpected'})]){
    assert.equal((await stopProcessTree(child,{platform:'linux',run,kill:()=>assert.fail('unknown ownership')})).confirmed,false);
  }
  assert.equal((await stopProcessTree(child,{platform:'linux',run:async()=>({stdout:'67890 12345 Z\n'}),kill:()=>assert.fail('already stopped')})).confirmed,true);
});
test('surviving groups and denied signals never become confirmed cleanup',async()=>{
 const signals=[],options={platform:'linux',run:async()=>({stdout:'12346 12345 S\n'}),graceMs:0,forceMs:0};
 const result=await stopProcessTree({pid:12345},{...options,kill:(pid,signal)=>signals.push([pid,signal])});
 assert.equal(result.confirmed,false);assert.deepEqual(signals,[[-12345,'SIGTERM'],[-12345,'SIGKILL']]);
 assert.equal((await stopProcessTree({pid:12345},{...options,kill:()=>{throw Object.assign(Error('denied'),{code:'EPERM'});}})).confirmed,false);
});
