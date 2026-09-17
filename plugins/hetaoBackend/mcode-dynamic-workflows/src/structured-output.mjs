import {failureError} from './failure.mjs';

// Compatibility is limited to transport formatting. Never synthesize missing data.
export function structuredOutput(raw,validate,stepId){
 if(validate(raw))return {output:raw,format:'native'};
 let candidate=raw,format='native';
 if(typeof raw==='string'){
  const text=raw.trim();
  try{candidate=JSON.parse(text);format='json';}
  catch{
   const fenced=text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
   if(!fenced||fenced[1].includes('```'))throw invalid('invalid_json');
   try{candidate=JSON.parse(fenced[1]);format='json_fence';}catch{throw invalid('invalid_json');}
  }
 }
 if(!validate(candidate))throw invalid('schema_mismatch',validate.errors);
 return {output:candidate,format};
 function invalid(reason,errors=[]){
  const issues=(errors??[]).slice(0,8).map(e=>({path:e.instancePath||'/',keyword:e.keyword,message:e.message,missingProperty:e.params?.missingProperty}));
  const cause=reason==='invalid_json'?'返回内容不是有效的完整 JSON 或单个完整 JSON 代码块。':issues.map(e=>`${e.path}${e.missingProperty?` 缺少 ${e.missingProperty}`:` ${e.message}`}`).join('；');
  return failureError({code:'OUTPUT_SCHEMA_INVALID',stepId,reason,issues,message:`节点 ${stepId} 的结构化输出无效：${cause}`,suggestion:'查看节点原始输出并核对 schema。不要读取失败结果的字段、填充猜测值或自动重试；保留未覆盖项后再决定修正或重跑。'});
 }
}
