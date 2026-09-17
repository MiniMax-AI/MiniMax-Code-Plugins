import { createHash } from 'node:crypto';
import { parse } from 'acorn';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex');
export function stable(value) { return JSON.stringify(canonical(value)); }
function canonical(v) { if (Array.isArray(v)) return v.map(canonical); if(v && typeof v==='object') return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])); return v; }
export function check(ok, message) { if(!ok) throw new Error(message); }
export function boundedJSON(value, max=512_000) { const s=JSON.stringify(value); check(s && Buffer.byteLength(s)<=max,'数据超过大小限制'); return s; }
export function validateScript(script) {
  check(typeof script==='string' && script.length>0 && script.length<=64_000,'脚本长度须在 1–64000 字符之间');
  const ast=parse(`async function workflow(ctx,input){\n${script}\n}`,{ecmaVersion:2023});
  const blocked=new Set(['ImportExpression','ImportDeclaration','ExportNamedDeclaration','ExportDefaultDeclaration','WithStatement']);
  function walk(node) { if(!node || typeof node!=='object') return; check(!blocked.has(node.type),'脚本不支持模块加载或导出'); if(node.type==='Identifier') check(!['eval','Function','Date','process','require','globalThis'].includes(node.name),`脚本不支持 ${node.name}`); if(node.type==='MemberExpression' && !node.computed) check(!['random','race','any','constructor','__proto__'].includes(node.property?.name),'脚本不支持不确定分支或动态代码构造'); for(const val of Object.values(node)) if(Array.isArray(val)) val.forEach(walk); else if(val && typeof val==='object') walk(val); }
  walk(ast); return {valid:true,scriptHash:hash(script),dslVersion:1};
}
export const TERMINAL=new Set(['succeeded','completed_with_gaps','failed','cancelled','interrupted','needs_attention']);
