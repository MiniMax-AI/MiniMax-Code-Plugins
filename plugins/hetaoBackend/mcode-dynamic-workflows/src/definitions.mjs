import {check} from './common.mjs';
export const METADATA_SCHEMA={type:'object',additionalProperties:false,properties:{objective:{type:'string',maxLength:1500},inputDescription:{type:'string',maxLength:1500},deliverables:{type:'array',maxItems:12,items:{type:'string',minLength:1,maxLength:300}}}};
export function normalizeMetadata(value={}) {
 check(value&&typeof value==='object'&&!Array.isArray(value),'metadata 必须为 object');
 check(Object.keys(value).every(k=>Object.hasOwn(METADATA_SCHEMA.properties,k)),'metadata 包含未知字段');
 for(const key of ['objective','inputDescription'])check(value[key]===undefined||(typeof value[key]==='string'&&value[key].length<=1500),`${key} 最多 1500 字符`);
 const deliverables=value.deliverables??[];
 check(Array.isArray(deliverables)&&deliverables.length<=12&&deliverables.every(v=>typeof v==='string'&&v.trim()&&v.length<=300),'deliverables 最多 12 项，每项 1–300 字符');
 return {objective:(value.objective??'').trim(),inputDescription:(value.inputDescription??'').trim(),deliverables:deliverables.map(v=>v.trim())};
}
export function templateDefinition(run){
 const keys=['name','script','input','metadata','executor','concurrency','maxCalls','maxSteps','stepTimeoutMs','runTimeoutMs'];
 return Object.fromEntries(keys.filter(k=>run[k]!==undefined).map(k=>[k,run[k]]));
}
