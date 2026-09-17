import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {mcodeExecute} from '../src/executor.mjs';

test('missing CLI diagnostic explains the public manual preflight',async()=>{
 await assert.rejects(mcodeExecute({id:'missing',prompt:'test'},{command:join(tmpdir(),randomUUID(),'mcode')}),error=>{
  assert.equal(error.details.code,'MCODE_START_FAILED');
  assert.match(error.message,/官方渠道/);assert.match(error.message,/mcode --version/);
  assert.doesNotMatch(error.message,/setup-mcode|--install/);return true;
 });
});
