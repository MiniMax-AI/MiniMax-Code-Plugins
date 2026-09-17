import {Marked} from 'marked';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeLink(value){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}}
const markdown=new Marked({gfm:true,breaks:false,renderer:{
 html({text}){return escapeHTML(text);},
 link({href,tokens}){const label=this.parser.parseInline(tokens),url=safeLink(href);return url?`<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`:label;},
 image({text,href}){const url=safeLink(href);return url?`<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(text||href)}</a>`:escapeHTML(text);},
 heading({tokens,depth}){const level=Math.min(6,depth+1);return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;}
}});
export function readingValue(value){
 for(let i=0;i<2&&typeof value==='string';i++){
  const trimmed=value.trim(),fence=trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i),text=fence?fence[1]:trimmed;
  if(!/^[{[]/.test(text))break;
  try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object')value=parsed;else break;}catch{break;}
 }
 return value;
}
const names={executiveSummary:['结论摘要','Executive summary'],reviewStatus:['审查状态','Review status'],conclusion:['结论','Conclusion'],summary:['摘要','Summary'],findings:['发现','Findings'],coverageLimitations:['覆盖限制','Coverage limitations'],coverageGaps:['覆盖缺口','Coverage gaps'],limitations:['限制与缺口','Limitations'],prioritizedActions:['建议行动','Recommended actions'],strengths:['优点','Strengths'],testAndQualityGaps:['测试与质量缺口','Test and quality gaps'],evidence:['证据','Evidence'],recommendation:['建议','Recommendation'],severity:['严重程度','Severity'],impact:['影响','Impact'],confidence:['置信度','Confidence'],objective:['任务目标','Objective'],inputDescription:['输入说明','Input description'],deliverables:['交付内容','Deliverables'],projectFound:['项目存在','Project found'],reviewableFiles:['可审查文件','Reviewable files'],excludedFiles:['排除文件','Excluded files'],techStack:['技术栈','Technology stack'],entryPoints:['入口','Entry points'],architectureMap:['架构结构','Architecture map'],qualityGates:['质量检查','Quality gates'],notes:['说明','Notes'],status:['状态','Status'],path:['路径','Path'],output:['结果','Output'],error:['错误','Error'],details:['详情','Details'],commandsRun:['已执行命令','Commands run'],confirmedFindings:['已确认发现','Confirmed findings'],rejectedFindings:['已排除发现','Rejected findings'],reviewerFailures:['审查失败','Reviewer failures']};
export function fieldLabel(key,language='en'){return names[key]?.[language==='zh'?0:1]??key.replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());}
export function rawText(value){return typeof value==='string'?value:JSON.stringify(value??null,null,2);}
export function readableHTML(input,{language='en',depth=0}={}){
 const value=readingValue(input),empty=language==='zh'?'无内容':'No content';
 if(value===null||value===undefined)return `<p class="content-empty">${empty}</p>`;
 if(typeof value==='string')return markdown.parse(value);
 if(typeof value!=='object')return `<p>${escapeHTML(value)}</p>`;
 if(depth>=8)return `<pre><code>${escapeHTML(rawText(value))}</code></pre>`;
 if(!Object.keys(value).length)return `<p class="content-empty">${Array.isArray(value)?(language==='zh'?'无条目':'No items'):empty}</p>`;
 const render=v=>readableHTML(v,{language,depth:depth+1});
 if(Array.isArray(value))return `<ol class="content-items">${value.map(v=>`<li>${render(v)}</li>`).join('')}</ol>`;
 return Object.entries(value).map(([key,v])=>`<section class="content-field"><h${Math.min(6,depth+3)}>${escapeHTML(fieldLabel(key,language))}</h${Math.min(6,depth+3)}>${render(v)}</section>`).join('');
}
export function markdownText(text,level=3){
 // Keep Markdown formatting; neutralize embedded HTML and unsafe link/image destinations.
 const angles=value=>String(value).replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const result=String(text);
 const tokens=markdown.lexer(result);
 return tokens.map(block=>{
  if(block.type==='code')return block.raw;
  let raw=angles(block.type==='heading'?'#'.repeat(Math.min(6,level+block.depth-1))+' '+block.text+'\n':block.raw);
  const changes=new Map(),code=[];
  markdown.walkTokens([block],token=>{if(token.type==='codespan')code.push(token.raw);if(['link','image','def'].includes(token.type)&&!safeLink(token.href))changes.set(angles(token.raw),token.type==='def'?'':angles(String(token.text??'').replace(/[\[\]]/g,'')));else if(token.type==='image')changes.set(angles(token.raw),`[${mdLabel(token.text||'Image')}](${safeLink(token.href)})`);});
  for(const [before,after]of changes)raw=raw.split(before).join(after);for(const literal of code)raw=raw.split(angles(literal)).join(literal);return raw;
 }).join('');
}
export const mdLabel=value=>String(value??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/[\\`*_{}\[\]()#+.!|~-]/g,'\\$&').replace(/\r?\n/g,' ');
export function codeFence(value){const text=JSON.stringify(value??null,null,2).replace(/</g,'\\u003c'),ticks='`'.repeat(Math.max(3,...[...text.matchAll(/`+/g)].map(x=>x[0].length+1)));return `${ticks}json\n${text}\n${ticks}`;}
export function readableMarkdown(input,{language='en',level=3}={}){
 const value=readingValue(input);if(value===null||value===undefined)return '—';
 if(typeof value==='string')return markdownText(value,level);
 if(typeof value!=='object')return String(value);
 if(!Object.keys(value).length)return language==='zh'?'无条目。':'No items.';
 if(level>6)return codeFence(value);
 if(Array.isArray(value))return value.map(v=>'- '+readableMarkdown(v,{language,level:level+1}).replace(/\n/g,'\n  ')).join('\n\n');
 return Object.entries(value).map(([k,v])=>`${'#'.repeat(level)} ${mdLabel(fieldLabel(k,language))}\n\n${readableMarkdown(v,{language,level:level+1})}`).join('\n\n');
}
export const contentStyles=`
.readable{font:14px/1.85 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#343547;overflow-wrap:anywhere;min-width:0}
.readable>*:first-child{margin-top:0}.readable h1,.readable h2,.readable h3,.readable h4,.readable h5,.readable h6{font-family:"Avenir Next","Segoe UI","PingFang SC",sans-serif;color:#252538;line-height:1.5;margin:1.8em 0 .65em;letter-spacing:0}.readable h2{font-size:23px}.readable h3{font-size:19px}.readable h4,.readable h5,.readable h6{font-size:15px}.readable p{margin:.6em 0;white-space:normal}.readable ul,.readable ol{padding-left:1.6em;margin:.8em 0}.readable li{margin:.5em 0}.readable li>p{margin:.3em 0}.readable a{color:#6550c6;text-underline-offset:3px}.readable code{font: .88em/1.7 "SFMono-Regular",Consolas,Menlo,monospace;background:#f0eef7;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere}.readable pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f9;border:1px solid #e4e6ed;border-radius:8px;padding:18px;line-height:1.7;font-size:12px;margin:1em 0}.readable pre code{padding:0;background:none}.readable blockquote{border-left:3px solid #a99ce2;margin:1em 0;padding:4px 18px;color:#65677a;background:#f7f6fb}.readable table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:1.2em 0;font-size:13px}.readable th,.readable td{border:1px solid #e4e6ed;text-align:left;padding:10px 14px;min-width:100px;max-width:520px;vertical-align:top}.readable th{background:#f4f3f9;color:#514771}.readable hr{border:0;border-top:1px solid #e4e6ed;margin:2em 0}.readable .content-field{border:0;border-top:1px solid #eeedf3;padding:16px 0;margin:0;background:none;border-radius:0}.readable .content-field>h3,.readable .content-field>h4,.readable .content-field>h5,.readable .content-field>h6{font-size:14px;color:#655887;margin:0 0 8px}.readable .content-field .content-field{margin-left:12px;border:0;padding:6px 0}.readable .content-empty{color:#8a8c9b;font-size:13px}.readable .content-items>li{padding:8px 0}.readable input[type=checkbox]{pointer-events:none}
`;
