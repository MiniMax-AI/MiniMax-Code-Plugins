import {workflowFailure} from './workflow-errors.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { readFile } from 'node:fs/promises';
const wasm = await readFile(new URL('./quickjs.wasm', import.meta.url));
const Q=await newQuickJSWASMModuleFromVariant(newVariant(variant,{wasmBinary:wasm}));const rt=Q.newRuntime();rt.setMemoryLimit(32*1024*1024);rt.setMaxStackSize(512*1024);
let deadline=Date.now()+1500;rt.setInterruptHandler(()=>Date.now()>deadline);
const vm=rt.newContext();const pending=new Map();let serial=0;let done=false;
function pump(){deadline=Date.now()+1500;const r=rt.executePendingJobs();if(r.error){const e=vm.dump(r.error);r.error.dispose();finish(false,e);}}
function finish(ok,value){if(done)return;done=true;parentPort.postMessage({type:'done',ok,value:ok?value:workflowFailure(value)});}
const bridge=vm.newFunction('__bridge',(method,arg)=>{
  if(pending.size>=100)throw new Error('Too many pending workflow operations');
  const payload=vm.getString(arg);if(payload.length>512_000)throw new Error('Workflow request too large');
  const id=++serial,promise=vm.newPromise();pending.set(id,promise);parentPort.postMessage({type:'call',id,method:vm.getString(method),payload:JSON.parse(payload)});return promise.handle;
});vm.setProp(vm.global,'__bridge',bridge);bridge.dispose();
parentPort.on('message',msg=>{const p=pending.get(msg.id);if(!p||done)return;pending.delete(msg.id);const h=vm.newString(JSON.stringify(msg.ok?msg.value:{error:msg.error,details:msg.details}));if(msg.ok)p.resolve(h);else p.reject(h);h.dispose();p.dispose();pump();});
const init=`
  const call = async (method,value) => {try{return JSON.parse(await __bridge(method,JSON.stringify(value)));}catch(raw){let data;try{data=JSON.parse(raw);}catch{throw raw;}const error=new Error(data.error??String(raw));error.details=data.details??null;throw error;}};
  const ctx=Object.freeze({agent:(spec,planId)=>call('agent',{spec,planId}),map:(items,fn)=>{if(!Array.isArray(items)||items.length>100)throw Error('map最多100项');return Promise.all(items.map(fn));},phase:spec=>call('phase',spec),log:(message,context={})=>call('log',{message:String(message),stepId:context.stepId,phase:context.phase}),checkpoint:(id,value)=>call('checkpoint',{id,value})});
  Object.defineProperty(Math,'random',{value:()=>{throw Error('random disabled')}});
  globalThis.Date=undefined;globalThis.eval=undefined;globalThis.Function=undefined;
  const input=JSON.parse(${JSON.stringify(JSON.stringify(workerData.input))});
  function freeze(v){if(v&&typeof v==='object'){Object.freeze(v);Object.values(v).forEach(freeze);}return v;}freeze(input);
  (async()=>{${workerData.script}\n})().catch(error=>{throw {message:typeof error?.message==='string'?error.message:String(error),details:error?.details??null};})
`;
try{
 const result=vm.evalCode(init);if(result.error){const e=vm.dump(result.error);result.error.dispose();finish(false,e);}
 else {const h=result.value;vm.resolvePromise(h).then(r=>{if(r.error){const e=vm.dump(r.error);r.error.dispose();finish(false,e);}else{const value=vm.dump(r.value);r.value.dispose();finish(true,value??null);}h.dispose();}).catch(e=>finish(false,e.message));pump();}
}catch(e){finish(false,e.message);}
