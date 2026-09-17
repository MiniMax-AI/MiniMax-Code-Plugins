import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {structuredOutput} from '../src/structured-output.mjs';
const ajv=new Ajv({strict:false,allErrors:true});
const schema={type:'object',required:['selected'],properties:{selected:{type:'object',required:['name','listed'],properties:{name:{type:'string'},listed:{type:'boolean'}}}}};
const object={selected:{name:'Example',listed:false}},json=JSON.stringify(object);
const parse=raw=>structuredOutput(raw,ajv.compile(schema),'identify');
test('structured output accepts native JSON, complete JSON text and whole JSON fences',()=>{
 for(const raw of [object,json,'\ufeff '+json+'\n','```json\n'+json+'\n```','```\n'+json+'\n```'])assert.deepEqual(parse(raw).output,object);
 assert.equal(parse(object).format,'native');assert.equal(parse(json).format,'json');assert.equal(parse('```json\n'+json+'\n```').format,'json_fence');
});
test('structured output refuses placeholders, prose extraction, ambiguous blocks and JSON repair',()=>{
 for(const raw of ['## 研究文档（引用来源参考）\n(no reference document available)','Here is the result: '+json,'```json\n'+json+'\n```\n```json\n'+json+'\n```','{selected: {name:"a"}}',json+',',JSON.stringify(json)])assert.throws(()=>parse(raw),e=>e.details.code==='OUTPUT_SCHEMA_INVALID'&&e.details.stepId==='identify');
});
test('validation keeps missing properties and strict types visible; no guessing or coercion',()=>{
 assert.throws(()=>parse({}),e=>e.details.issues.some(i=>i.missingProperty==='selected'));
 assert.throws(()=>parse({selected:{name:'a',listed:'false'}}),e=>e.details.reason==='schema_mismatch'&&e.details.issues.some(i=>i.path==='/selected/listed'));
 for(const raw of [null,[],false])assert.throws(()=>parse(raw),/结构化输出无效/);
});
test('schemas allowing text preserve text, including JSON-looking reports',()=>{
 const validate=ajv.compile({type:'string'});assert.equal(structuredOutput(json,validate,'report').output,json);
});
