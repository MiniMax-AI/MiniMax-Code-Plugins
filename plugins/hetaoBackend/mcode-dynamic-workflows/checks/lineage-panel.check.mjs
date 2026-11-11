// Regression nail for the lineage panel render-idempotence bugs found by the
// egolite interaction pass: polling over an unchanged family must keep the
// user's compare pair and open diff (identity signature stable), while live
// member data (status, duration, trash/archive flags) must stay refreshable
// through the member cards without forcing a control rebuild.
import test from 'node:test';import assert from 'node:assert/strict';
import {compareSignature,shouldRebuildCompare} from '../web/lineage-model.mjs';
const member=(id,rerunSeq,name,extra={})=>({id,rerunSeq,name,status:'succeeded',createdAt:1,durationMs:1000,resultPreview:null,deleted:null,archived:null,...extra});
const family=[member('run-root',0,'Family root'),member('run-rerun-1',1,'First rerun',{status:'running',durationMs:400})];
test('poll-shaped refresh (fresh objects, moved live data, fixed identity) keeps the compare controls',()=>{
 const before=compareSignature('zh',family);
 const poll=family.map(m=>({...m,status:'succeeded',durationMs:m.durationMs+9000,resultPreview:'done'}));
 assert.equal(shouldRebuildCompare(before,compareSignature('zh',poll)),false);
 assert.equal(compareSignature('zh',family),compareSignature('zh',[...family]));
});
test('trash restore clears deleted flags without rebuilding the compare pair',()=>{
 const trashed=family.map(m=>m.id==='run-rerun-1'?{...m,deleted:{at:2,by:'studio'}}:m);
 const restored=trashed.map(m=>({...m,deleted:null}));
 assert.equal(shouldRebuildCompare(compareSignature('en',trashed),compareSignature('en',restored)),false);
});
test('identity changes (member added, removed or reordered) rebuild the controls',()=>{
 const before=compareSignature('zh',family);
 assert.equal(shouldRebuildCompare(before,compareSignature('zh',[...family,member('run-rerun-2',2,'Second rerun')])),true);
 assert.equal(shouldRebuildCompare(before,compareSignature('zh',family.slice(0,1))),true);
 assert.equal(shouldRebuildCompare(before,compareSignature('zh',[...family].reverse())),true);
});
test('language switch and member renames rebuild so option labels stay faithful',()=>{
 assert.equal(shouldRebuildCompare(compareSignature('zh',family),compareSignature('en',family)),true);
 assert.equal(shouldRebuildCompare(compareSignature('zh',family),compareSignature('zh',family.map(m=>m.id==='run-root'?{...m,name:'Renamed'}:m))),true);
});
test('first render of any family rebuilds and empty/missing members are safe',()=>{
 assert.equal(shouldRebuildCompare('',compareSignature('zh',family)),true);
 assert.equal(compareSignature('zh',[]),compareSignature('zh',null));
});
