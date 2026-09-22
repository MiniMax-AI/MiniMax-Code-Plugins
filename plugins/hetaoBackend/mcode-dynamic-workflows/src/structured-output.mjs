import {failureError} from './failure.mjs';

// Compatibility is limited to transport formatting. Never synthesize missing data.
// Unambiguous single-candidate extraction stays inside that boundary: a candidate is only
// accepted when the extracted bytes are exactly what strictly parsing that one candidate
// yields (no repair, no coercion, no synthesised fields), the schema remains the sole data
// gate, and any ambiguity is rejected untouched — multiple fences or bare candidates, a JSON
// structural character (, ] } :) right after the closing bracket (a truncation tell), nested
// fences, placeholders. Fences outrank bare candidates; a single malformed fence is still
// repair-needed text and never falls through to bare extraction.
export function structuredOutput(raw,validate,stepId){
 if(validate(raw))return {output:raw,format:'native'};
 let candidate=raw,format='native';
 if(typeof raw==='string'){
  const text=raw.trim();
  try{candidate=JSON.parse(text);format='json';}
  catch{
   const blocks=[...text.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/gi)];
   if(blocks.length>1)throw invalid('invalid_json');
   if(blocks.length===1){
    if(blocks[0][1].includes('```'))throw invalid('invalid_json');
    try{candidate=JSON.parse(blocks[0][1]);format=blocks[0][0]===text?'json_fence':'json_fence_embedded';}
    catch{throw invalid('invalid_json');}
   }else{
    const spans=bareSpans(text);
    if(spans.length!==1)throw invalid('invalid_json');
    const tail=text.slice(spans[0][1]).match(/\S/);
    if(tail&&',]}:'.includes(tail[0]))throw invalid('invalid_json');
    try{candidate=JSON.parse(text.slice(spans[0][0],spans[0][1]));format='json_embedded';}
    catch{throw invalid('invalid_json');}
   }
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
// String-aware scan for top-level balanced {...}/[...] spans: braces and brackets inside JSON
// string literals (including \" and \\ escapes) never count depth; only { and [ open a candidate.
function bareSpans(text){
 const spans=[];let depth=0,start=-1,inString=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(inString){
   if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;
   continue;
  }
  if(ch==='"')inString=true;
  else if(ch==='{'||ch==='['){if(depth===0)start=i;depth++;}
  else if((ch==='}'||ch===']')&&depth>0){depth--;if(depth===0){spans.push([start,i+1]);start=-1;}}
 }
 return spans;
}
