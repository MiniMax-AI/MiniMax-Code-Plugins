import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {structuredOutput} from '../src/structured-output.mjs';
const ajv=new Ajv({strict:false,allErrors:true});
const schema={type:'object',required:['selected'],properties:{selected:{type:'object',required:['name','listed'],properties:{name:{type:'string'},listed:{type:'boolean'}}}}};
const object={selected:{name:'Example',listed:false}},json=JSON.stringify(object),other=JSON.stringify({selected:{name:'Other',listed:true}});
const parse=raw=>structuredOutput(raw,ajv.compile(schema),'identify');
const refuses=(raw,reason)=>assert.throws(()=>parse(raw),e=>e.details.code==='OUTPUT_SCHEMA_INVALID'&&e.details.stepId==='identify'&&e.details.reason===reason);
test('structured output accepts native JSON, complete JSON text and whole JSON fences',()=>{
 for(const raw of [object,json,'\ufeff '+json+'\n','```json\n'+json+'\n```','```\n'+json+'\n```'])assert.deepEqual(parse(raw).output,object);
 assert.equal(parse(object).format,'native');assert.equal(parse(json).format,'json');assert.equal(parse('```json\n'+json+'\n```').format,'json_fence');
});
test('structured output extracts the single unambiguous JSON candidate from surrounding prose (2026-09-20 user report: render judged OUTPUT_SCHEMA_INVALID on JSON plus trailing prose)',()=>{
 for(const raw of ['Here is the result: '+json,json+' 以上为最终结果，请查收。','前置说明：\n'+json+'\n后续备注：详见原文。','\ufeff '+json+'\n 附注']){const parsed=parse(raw);assert.deepEqual(parsed.output,object);assert.equal(parsed.format,'json_embedded');}
});
test('structured output extracts a single fence embedded in prose without whole-text anchoring; fences outrank bare candidates',()=>{
 for(const raw of ['```json\n'+json+'\n```\n以上为最终结果。','报告如下：\n```json\n'+json+'\n```','前言行 ```json\n'+json+'\n``` 收尾行','中间结果 '+json+'，最终答案如下 ```json\n'+json+'\n```']){const parsed=parse(raw);assert.deepEqual(parsed.output,object);assert.equal(parsed.format,'json_fence_embedded');}
});
test('structured output refuses placeholders, ambiguous blocks and JSON repair',()=>{
 refuses('## 研究文档（引用来源参考）\n(no reference document available)','invalid_json');
 refuses('```json\n'+json+'\n```\n```json\n'+json+'\n```','invalid_json');
 refuses('{selected: {name:"a"}}','invalid_json');
 refuses(json+',','invalid_json');
 refuses(JSON.stringify(json),'schema_mismatch');
});
test('structured output refuses multiple bare candidates, truncation-adjacent closers and nested fences',()=>{
 refuses('a '+json+' b '+other+' c','invalid_json');
 refuses(json+']','invalid_json');
 refuses(json+'}','invalid_json');
 refuses('```json\n```json\n'+json+'\n```\n```','invalid_json');
 refuses('序 ```json\n内嵌 ```x``` 注\n'+json+'\n``` 尾','invalid_json');
});
test('validation keeps missing properties and strict types visible; no guessing or coercion',()=>{
 assert.throws(()=>parse({}),e=>e.details.issues.some(i=>i.missingProperty==='selected'));
 assert.throws(()=>parse({selected:{name:'a',listed:'false'}}),e=>e.details.reason==='schema_mismatch'&&e.details.issues.some(i=>i.path==='/selected/listed'));
 for(const raw of [null,[],false])assert.throws(()=>parse(raw),/结构化输出无效/);
});
test('schemas allowing text preserve text, including JSON-looking reports',()=>{
 const validate=ajv.compile({type:'string'});assert.equal(structuredOutput(json,validate,'report').output,json);
});
