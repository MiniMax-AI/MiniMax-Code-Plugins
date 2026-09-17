#!/usr/bin/env node
// Executes the mechanical claims table from VERIFICATION.md.
// Exit 0 when every row matches its expected exit status, 1 on the first
// mismatch, 2 when this tool itself cannot run. POSIX shells only.
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const table=readFileSync(join(root,'VERIFICATION.md'),'utf8').match(/```verify\r?\n([\s\S]*?)```/);
if(!table){console.error('[verify-claims] VERIFICATION.md has no ```verify table');process.exit(2);}
const rows=[...table[1].matchAll(/^\| ([A-Z][A-Z0-9-]*) \| (.+?) \| exit (\d+) \|$/gm)];
if(!rows.length){console.error('[verify-claims] table has no claim rows');process.exit(2);}
for(const [,id,command,expect] of rows){
 const result=spawnSync('/bin/sh',['-c',command],{cwd:root,stdio:'inherit'});
 if(result.error){console.error(`[verify-claims] ERROR ${id}: ${result.error.message}`);process.exit(2);}
 if(result.status!==Number(expect)){console.error(`[verify-claims] FAIL ${id}: ${command} (exit ${result.status}, expected ${expect})`);process.exit(1);}
 console.log(`[verify-claims] PASS ${id}`);
}
console.log(`[verify-claims] ${rows.length} claims verified`);
