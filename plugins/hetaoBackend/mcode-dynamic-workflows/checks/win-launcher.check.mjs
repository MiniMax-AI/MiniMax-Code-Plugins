import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile,rm,readFile,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveMcode} from '../src/mcode-location.mjs';
// Windows launcher resolution is exercised from POSIX by faking the on-disk
// layout and passing platform:'win32' + a controlled PATH/PATHEXT: resolution
// is pure filesystem probing, so the real bug (mixed-install layouts) is
// reproducible without a Windows host. Nothing here is Windows-skipped — the
// suite is meant to run in the repository's windows CI job too (workflow patch
// ships with this change), and the end-to-end test below spawns a real node
// subprocess on whichever host executes it. PATHEXT case matches the fixtures
// (.cmd lowercase): real Windows filesystems are case-insensitive, POSIX
// runners simulating win32 are not.
async function layout(){
 const root=await mkdir(join(tmpdir(),`wf-winloc-${crypto.randomUUID()}`),{recursive:true});
 const shim=join(root,'shim'),official=join(root,'official');
 const mk=async(dir,rel,content)=>{const file=join(dir,...rel);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,content);return file;};
 return {root,shim,official,mk,cleanup:async()=>{await rm(root,{recursive:true,force:true});}};
}
const pkg=version=>JSON.stringify({name:'@minimax-ai/code',version});
async function install(dir,{version,withCmd=true,withPs1=true,npmLayout=false}={}){
 await mkdir(dir,{recursive:true});
 if(withCmd){await writeFile(join(dir,'mcode.cmd'),'@echo off');await writeFile(join(dir,'powershell.exe'),'fake');}
 if(withPs1)await writeFile(join(dir,'mcode.ps1'),'# launcher');
 if(version){const rel=npmLayout?['node_modules','@minimax-ai','code']:['lib','node_modules','@minimax-ai','code'];
  await mkdir(join(dir,...rel),{recursive:true});
  await writeFile(join(dir,...rel,'cli.js'),'#!/usr/bin/env node');
  await writeFile(join(dir,...rel,'package.json'),pkg(version));}
}
const release=async(root,dir,version,entry='#!/usr/bin/env node')=>{
 const rel=join(root,'releases',dir,'node_modules','@minimax-ai','code');
 await mkdir(rel,{recursive:true});await writeFile(join(rel,'cli.js'),entry);await writeFile(join(rel,'package.json'),pkg(version));
 return join(rel,'cli.js');
};
const versionAt=async entry=>JSON.parse(await readFile(join(entry,'..','package.json'),'utf8')).version;
const winEnv=(shim)=>({PATH:`${shim};C:\\Windows\\System32`,PATHEXT:'.cmd;.bat',SystemRoot:'C:\\Windows'});
test('mixed installs: ps1 present, old npm-shim beside a newer official install -> direct node entry of the newest',async()=>{
 const f=await layout();try{
  await install(f.shim,{version:'0.2.7',npmLayout:true});          // PATH shim with old sibling cli.js
  await install(join(f.official,'.minimax-code'),{version:'0.4.12'}); // official layout, newer
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.ok(r,'resolves');assert.equal(r.command,process.execPath,'no powershell -File hop');
  assert.match(r.args[0],/lib[\\/]node_modules.*cli\.js$/);assert.match(r.args[0],/0?4\.12|^.*official/);
  assert.equal(await versionAt(r.args[0]),'0.4.12','newest wins');
 }finally{await f.cleanup();}
});
test('ps1 renamed away, old npm-shim sibling remains -> newest official entry, never the stale sibling',async()=>{
 const f=await layout();try{
  await install(f.shim,{version:'0.2.7',npmLayout:true,withPs1:false});
  await install(join(f.official,'.minimax-code'),{version:'0.4.12'});
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.equal(await versionAt(r.args[0]),'0.4.12');
 }finally{await f.cleanup();}
});
test('no launcher: higher SemVer wins regardless of origin (stable 0.5.0 npm-shim sibling beats stable 0.4.12 official)',async()=>{
 const f=await layout();try{
  await install(f.shim,{version:'0.5.0',npmLayout:true});
  await install(join(f.official,'.minimax-code'),{version:'0.4.12'});
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.equal(await versionAt(r.args[0]),'0.5.0');
 }finally{await f.cleanup();}
});
test('single npm layout without official install -> sibling entry via direct node',async()=>{
 const f=await layout();try{
  await install(f.shim,{version:'0.4.12',npmLayout:true});
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.equal(r.command,process.execPath);assert.match(r.args[0],/node_modules.*cli\.js$/);
 }finally{await f.cleanup();}
});
test('no node entry anywhere but ps1 exists -> documented powershell -File last resort',async()=>{
 const f=await layout();try{
  await install(f.shim,{}); // cmd + ps1, no cli.js anywhere
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.match(r.command,/powershell|pwsh/i);assert.deepEqual(r.args.slice(0,3),['-NoProfile','-File',join(f.shim,'mcode.ps1')]);
 }finally{await f.cleanup();}
});
test('cmd without any entry and without ps1 still fails with the repair hint',async()=>{
 const f=await layout();try{
  await install(f.shim,{withPs1:false});
  await assert.rejects(resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'}),/cli\.js|修复/);
 }finally{await f.cleanup();}
});
test('posix resolution is unchanged',async()=>{
 const f=await layout();try{
  await mkdir(f.shim,{recursive:true});await writeFile(join(f.shim,'mcode'),'#!/bin/sh');await chmod(join(f.shim,'mcode'),0o755);
  const r=await resolveMcode('mcode',{env:{PATH:f.shim},home:f.official,platform:'linux'});
  assert.equal(r.command,join(f.shim,'mcode'));assert.deepEqual(r.args,[]);
 }finally{await f.cleanup();}
});

test('field layout: extensionless mcode + mcode.cmd + ps1 + stale sibling + releases/0.4.12 -> newest via node, never the bash script',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(f.shim,{});                       // provides fake powershell.exe + pwsh? (powershell only)
  await writeFile(join(f.shim,'pwsh.exe'),'fake'); // pwsh preferred on the last-resort path
  await mkdir(root,{recursive:true});
  await writeFile(join(root,'mcode'),'#!/bin/sh'); // extensionless bash script — must never be spawned
  await install(root,{version:'0.2.7',npmLayout:true,withCmd:true,withPs1:true});
  await release(root,'0.4.12','0.4.12');
  // PATHEXT case must match the fixture files: real Windows filesystems are
  // case-insensitive, but the POSIX runners simulating win32 are not — probing
  // mcode.CMD against a lowercase mcode.cmd would miss on Linux.
  const env={PATH:`${root};${f.shim}`,PATHEXT:'.cmd;.bat',SystemRoot:'C:\\Windows'};
  const r=await resolveMcode('mcode',{env,home:f.official,platform:'win32'});
  assert.ok(r,'resolution must succeed on the field layout');
  assert.equal(r.command,process.execPath,'extensionless bash script must not be selected');
  assert.equal(await versionAt(r.args[0]),'0.4.12','releases layout wins over stale sibling');
 }finally{await f.cleanup();}
});
test('ps1 renamed, sibling 0.2.7, releases/0.4.12 present -> releases entry (not the sibling)',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{version:'0.2.7',npmLayout:true,withPs1:false});
  await release(root,'0.4.12','0.4.12');
  const r=await resolveMcode('mcode',{env:winEnv(root),home:f.official,platform:'win32'});
  assert.equal(await versionAt(r.args[0]),'0.4.12');
 }finally{await f.cleanup();}
});
test('launcher pointer is the authoritative active target: .mcode-launcher.cmd decides, not version ranking',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{version:'0.2.7',npmLayout:true});            // stale flat sibling beside the shim
  await release(root,'0.4.12','0.4.12');
  await release(root,'0.5.0-beta.1','0.5.0-beta.1');
  const launcher=join(root,'.mcode-launcher.cmd');
  const env={PATH:root,PATHEXT:'.cmd;.bat',SystemRoot:'C:\\Windows'};
  // backslash form, pointer at 0.4.12: the launcher target wins — and in
  // particular the numerically larger 0.5.0-beta.1 directory is NOT trusted.
  await writeFile(launcher,'@echo off\r\nnode "%~dp0releases\\0.4.12\\node_modules\\@minimax-ai\\code\\cli.js" %*\r\n');
  let r=await resolveMcode('mcode',{env,home:f.official,platform:'win32'});
  assert.ok(r,'resolves via launcher pointer');assert.equal(r.command,process.execPath);
  assert.match(r.args[0],/releases[\\/]0\.4\.12[\\/]node_modules/);
  assert.equal(await versionAt(r.args[0]),'0.4.12','follows the launcher pointer, not the larger-numbered beta dir');
  // forward-slash form, pointer moved to the beta: the SemVer fallback would
  // keep stable 0.4.12, so only the authoritative pointer can select the beta —
  // rollback and channel switches are followed for free.
  await writeFile(launcher,'@echo off\r\nnode "%~dp0releases/0.5.0-beta.1/node_modules/@minimax-ai/code/cli.js" %*\r\n');
  r=await resolveMcode('mcode',{env,home:f.official,platform:'win32'});
  assert.match(r.args[0],/releases[\\/]0\.5\.0-beta\.1[\\/]node_modules/);
  assert.equal(await versionAt(r.args[0]),'0.5.0-beta.1','pointer moved -> resolution follows');
 }finally{await f.cleanup();}
});
test('no launcher: SemVer fallback — stable outranks prerelease (0.4.12 over 0.5.0-beta.1)',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{});                                          // shim only, no sibling candidate
  await release(root,'0.4.12','0.4.12');
  await release(root,'0.5.0-beta.1','0.5.0-beta.1');
  const r=await resolveMcode('mcode',{env:winEnv(root),home:f.official,platform:'win32'});
  assert.equal(r.command,process.execPath);
  assert.equal(await versionAt(r.args[0]),'0.4.12','stable beats the numerically larger prerelease');
 }finally{await f.cleanup();}
});
test('no launcher: prerelease identifiers compare numerically (0.5.0-beta.10 outranks 0.5.0-beta.2)',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{});
  await release(root,'0.5.0-beta.2','0.5.0-beta.2');
  await release(root,'0.5.0-beta.10','0.5.0-beta.10');
  const r=await resolveMcode('mcode',{env:winEnv(root),home:f.official,platform:'win32'});
  assert.match(r.args[0],/releases[\\/]0\.5\.0-beta\.10[\\/]node_modules/,'numeric identifier order, not lexicographic');
 }finally{await f.cleanup();}
});
test('no launcher: full SemVer tie (build metadata ignored) breaks by directory name, greatest wins',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{});
  await release(root,'0.4.12','0.4.12');
  await release(root,'0.4.12+build.2','0.4.12+build.2');
  const r=await resolveMcode('mcode',{env:winEnv(root),home:f.official,platform:'win32'});
  assert.match(r.args[0],/releases[\\/]0\.4\.12\+build\.2[\\/]node_modules/,'lexicographically greatest directory name wins the tie');
 }finally{await f.cleanup();}
});
test('end-to-end argv fidelity: resolved node entry spawns with spaced cwd and flag-shaped tokens intact',async()=>{
 const f=await layout();try{
  const root=join(f.official,'.minimax-code');
  await install(root,{});
  // fake cli.js: echoes its own argv as one JSON line — plain node, spawnable
  // without any shell (we spawn node + path, so no shebang is needed).
  await release(root,'0.4.12','0.4.12','process.stdout.write(JSON.stringify(process.argv.slice(2)))\n');
  const r=await resolveMcode('mcode',{env:winEnv(root),home:f.official,platform:'win32'});
  assert.ok(r);assert.equal(r.command,process.execPath,'direct node entry');
  const cwd=join(f.root,'work dir with spaces');
  await mkdir(cwd,{recursive:true});
  const sent=['exec','--input','-','--cwd',cwd,'--output-format','stream-json','--flag-shape-toy','-'];
  const stdout=await new Promise((res,rej)=>{
   const p=spawn(r.command,[r.args[0],...sent],{stdio:['ignore','pipe','inherit']}); // stdin irrelevant to argv fidelity
   let out='';p.stdout.setEncoding('utf8');p.stdout.on('data',d=>{out+=d;});
   p.on('error',rej);p.on('close',code=>code===0?res(out):rej(new Error(`fake cli.js exited with ${code}`)));
  });
  assert.deepEqual(JSON.parse(stdout),sent,'every argv token survives verbatim: spaced path, flag-shaped tokens, trailing dash');
 }finally{await f.cleanup();}
});
test('last-resort PS hop prefers pwsh (PS7) over powershell (PS5.1 -File is broken in the field)',async()=>{
 const f=await layout();try{
  await install(f.shim,{});await writeFile(join(f.shim,'pwsh.exe'),'fake');
  const r=await resolveMcode('mcode',{env:winEnv(f.shim),home:f.official,platform:'win32'});
  assert.match(r.command,/pwsh\.exe$/i);
 }finally{await f.cleanup();}
});
