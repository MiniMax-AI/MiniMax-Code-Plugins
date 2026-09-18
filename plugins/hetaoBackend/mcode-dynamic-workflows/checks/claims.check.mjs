import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {CLAIMS,parseMirror} from '../scripts/verify-claims.mjs';
const mirror=async()=>parseMirror(await readFile('VERIFICATION.md','utf8'));
const wrap=rows=>['```verify','| id | command | expect |','|----|---------|--------|',...rows,'```'].join('\n');
test('the VERIFICATION.md mirror equals the executable claims exactly, in order',async()=>{
 const rows=await mirror();
 assert.deepEqual(rows.map(r=>({id:r.id,display:r.display,expect:r.expect})),CLAIMS.map(c=>({id:c.id,display:c.display,expect:c.expect})));
});
test('claims data is internally valid',()=>{
 assert.ok(CLAIMS.length>=1);assert.deepEqual(CLAIMS.map(c=>c.id),[...new Set(CLAIMS.map(c=>c.id))],'ids unique');
 for(const c of CLAIMS){assert.match(c.id,/^[A-Z][A-Z0-9-]*$/);assert.ok(Array.isArray(c.argv)&&c.argv.length>0);assert.ok(Number.isInteger(c.expect));}
});
test('negative: a malformed header is rejected, not skipped',()=>{
 const md=['```verify','| id | command | wanted |','|----|---------|--------|','| V-01 | npm test | exit 0 |','```'].join('\n');
 assert.throws(()=>parseMirror(md),/bad header/);
});
test('negative: an unparseable row fails the whole parse (no silent omission)',()=>{
 const md=wrap(['| V-01 | npm test | exit zero |']);
 assert.throws(()=>parseMirror(md),/unparseable row/);
});
test('negative: duplicate IDs are rejected',()=>{
 const md=wrap(['| V-01 | npm test | exit 0 |','| V-01 | npm test | exit 0 |']);
 assert.throws(()=>parseMirror(md),/duplicate id/);
});
test('negative: a smuggled extra row beyond the claims data breaks mirror equality',async()=>{
 const rows=await mirror();
 assert.notDeepEqual([...rows.map(r=>r.id),'V-99'],CLAIMS.map(c=>c.id));
});
test('negative: reordered mirror rows break equality even with identical members',async()=>{
 const rows=await mirror();
 if(rows.length<2) return;
 const reordered=[...rows.slice(1),rows[0]];
 assert.notDeepEqual(reordered.map(r=>r.id),CLAIMS.map(c=>c.id));
});
test('negative: a missing verify block is an error',()=>{
 assert.throws(()=>parseMirror('# no block here'),/no .*verify block/);
});
