// extract.js — JS/TS 源码中的调用与对象字面量提取（零依赖）
//
// 用于：
//   - dsh2mcode：从 DSH 插件源码提取 registerTool/defineTool/ctx.on 调用
//   - mcode2dsh：从 pi extension 源码提取 registerTool/registerCommand 调用
// 实现：词法级扫描（字符串/注释/括号配对），不做完整 JS 解析。

'use strict';

// 找到所有匹配正则的"调用"并截取平衡括号内的参数文本
// namePattern: RegExp，匹配函数名（不含 '('），可带捕获组 1 作为"名字"（如事件名）
function findCalls(source, namePattern) {
  const re = new RegExp(namePattern.source, namePattern.flags.includes('g') ? namePattern.flags : namePattern.flags + 'g');
  const out = [];
  // 注释区间（跳过注释内被匹配的调用，如注释掉的 tools.register 示例）
  const comments = commentRanges(source);
  let ci = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    // 跳过注释内的匹配
    while (ci < comments.length && comments[ci][1] <= m.index) ci++;
    if (ci < comments.length && m.index >= comments[ci][0]) {
      continue; // exec 已自动推进 lastIndex
    }
    // 跳过作为字符串一部分的匹配：检查前一个非空白字符
    let k = m.index - 1;
    while (k >= 0 && /\s/.test(source[k])) k--;
    if (k >= 0 && (source[k] === '"' || source[k] === "'" || source[k] === '`')) continue;
    // 扫描到下一个 '('
    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '(') continue;
    const close = matchParen(source, i);
    if (close < 0) continue;
    out.push({
      start: m.index,
      end: close + 1,
      argsStart: i + 1,
      argsEnd: close,
      argsText: source.slice(i + 1, close),
      name: m[1] !== undefined ? m[1] : m[0],
    });
    re.lastIndex = close + 1;
  }
  return out;
}

// 从 pos 开始的 '(' 找到配对的 ')'（支持嵌套与字符串/注释）
function matchParen(source, pos) {
  const stack = [];
  let i = pos;
  let state = 'code'; // code | str-single | str-double | str-template | line-comment | block-comment
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'line-comment') {
      if (c === '\n') state = 'code';
      i++;
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && n === '/') {
        state = 'code';
        i += 2;
      } else i++;
      continue;
    }
    if (state === 'str-single') {
      if (c === '\\') i += 2;
      else if (c === "'") state = 'code', i++;
      else i++;
      continue;
    }
    if (state === 'str-double') {
      if (c === '\\') i += 2;
      else if (c === '"') state = 'code', i++;
      else i++;
      continue;
    }
    if (state === 'str-template') {
      if (c === '\\') i += 2;
      else if (c === '`') state = 'code', i++;
      else if (c === '$' && n === '{') {
        // 模板插值：进入代码态直到匹配的 }
        i += 2;
        const close = matchParen(source, i - 1);
        if (close < 0) return -1;
        i = close + 1;
      } else i++;
      continue;
    }
    if (state === 'regex') {
      // regex literal（如 /\\)/ 里的 ')' 不是闭括号）：\x 转义；未转义 / 结束；换行视为非法结束
      if (c === '\\') i += 2;
      else if (c === '/') state = 'code', i++;
      else if (c === '\n') return -1;
      else i++;
      continue;
    }
    // code 态
    if (c === '/' && n === '/') { state = 'line-comment'; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block-comment'; i += 2; continue; }
    // regex literal 起始：`/` 在表达式起始位置（操作符/分隔符/关键字后）时按 regex 处理
    if (c === '/' && regexStart(source, i)) { state = 'regex'; i++; continue; }
    if (c === "'") { state = 'str-single'; i++; continue; }
    if (c === '"') { state = 'str-double'; i++; continue; }
    if (c === '`') { state = 'str-template'; i++; continue; }
    if (c === '(' || c === '{' || c === '[') { stack.push(c === '(' ? ')' : c === '{' ? '}' : ']'); i++; continue; }
    if (c === ')' || c === '}' || c === ']') {
      const want = stack.pop();
      if (want === undefined) return -1;
      if (want !== c) return -1;
      if (stack.length === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// 判断 source[i] 的 '/' 是否是 regex literal 起始（而非除法/注释）。
// 启发式：前一个非空白字符是行首、开括号/分隔符/运算符，或关键字（return 等）。
const REGEX_PREFIX_RE = /(?:return|typeof|case|in|of|delete|void|new|instanceof|yield|throw|else|do|if|while|for|switch|await)\s*$/;
function regexStart(source, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(source[k])) k--;
  if (k < 0) return true;
  const c = source[k];
  if ('([{,;=:!&|?+-*%<>^~'.includes(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let j = k;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(source[j - 1])) j--;
    return REGEX_PREFIX_RE.test(source.slice(j, k + 1));
  }
  return false;
}

// 注释区间列表（[start, end)），供 findCalls 跳过注释内匹配
function commentRanges(source) {
  const ranges = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const start = i;
      const nl = source.indexOf('\n', i + 2);
      i = nl < 0 ? len : nl + 1;
      ranges.push([start, i]);
      continue;
    }
    if (c === '/' && n === '*') {
      const start = i;
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? len : end + 2;
      ranges.push([start, i]);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < len) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === q) { i++; break; }
        else i++;
      }
      continue;
    }
    i++;
  }
  return ranges;
}

// text[0, pos) 的未闭合括号深度（词法感知），用于判断属性是否处于对象顶层
function nestingDepthAt(text, pos) {
  let depth = 0;
  let i = 0;
  const len = Math.min(pos, text.length);
  let state = 'code';
  while (i < len) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 'line-comment') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block-comment') { if (c === '*' && n === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'str-single') { if (c === '\\') i += 2; else if (c === "'") { state = 'code'; i++; } else i++; continue; }
    if (state === 'str-double') { if (c === '\\') i += 2; else if (c === '"') { state = 'code'; i++; } else i++; continue; }
    if (state === 'str-template') { if (c === '\\') i += 2; else if (c === '`') { state = 'code'; i++; } else i++; continue; }
    if (state === 'regex') { if (c === '\\') i += 2; else if (c === '/') { state = 'code'; i++; } else i++; continue; }
    if (c === '/' && n === '/') { state = 'line-comment'; i += 2; continue; }
    if (c === '/' && n === '*') { state = 'block-comment'; i += 2; continue; }
    if (c === '/' && regexStart(text, i)) { state = 'regex'; i++; continue; }
    if (c === "'") { state = 'str-single'; i++; continue; }
    if (c === '"') { state = 'str-double'; i++; continue; }
    if (c === '`') { state = 'str-template'; i++; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    i++;
  }
  return depth;
}

// 提取源码中的相对导入路径（'./x' / '../x'），去重
function relativeImports(source) {
  const out = [];
  const seen = new Set();
  const re = /(?:from\s*|require\s*\(\s*|import\s*\(\s*|import\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
  for (const m of source.matchAll(re)) {
    if (m[2] && !seen.has(m[2])) { seen.add(m[2]); out.push(m[2]); }
  }
  return out;
}

// 从对象字面量文本中提取某个属性的值（平衡截取；字符串返回解引号后的值）
function propertyValue(objText, key, opts = {}) {
  const topLevel = !!opts.topLevel;
  // 必须带 g flag：循环依赖 exec 的 lastIndex 推进
  const re = new RegExp('(?:^|[,{\\s])' + key + '\\s*:', 'g');
  let m;
  while ((m = re.exec(objText)) !== null) {
    // 顶层模式：跳过嵌套属性（如 parameters 里的 name 字段）。
    // 顶层对象成员 name 位置的深度恒为 1（'{' 之后）；嵌套成员 >= 2；
    // 不以 '{' 开头的裸文本（depth 0）也视为顶层。
    const namePos = m.index + m[0].indexOf(key);
    const depth = nestingDepthAt(objText, namePos);
    if (topLevel && !(depth === 1 || (depth === 0 && !objText.startsWith('{')))) {
      continue;
    }
    const value = propertyValueAt(objText, key, m);
    if (value !== undefined) return value;
    if (!topLevel) return undefined;
  }
  return undefined;
}

// 在已匹配的位置解析属性值（供 propertyValue 循环复用）
function propertyValueAt(objText, key, m) {
  let i = m.index + m[0].length;
  while (i < objText.length && /\s/.test(objText[i])) i++;
  if (i >= objText.length) return undefined;
  const c = objText[i];
  if (c === '"' || c === "'" || c === '`') {
    // 字符串值：读到匹配的结束引号（简单处理转义）
    const quote = c;
    let j = i + 1;
    let out = '';
    while (j < objText.length) {
      const ch = objText[j];
      if (ch === '\\') { out += objText[j + 1] ?? ''; j += 2; continue; }
      if (ch === quote) break;
      out += ch;
      j++;
    }
    return { kind: 'string', value: out, start: i, end: j + 1 };
  }
  if (c === '(' || c === '{' || c === '[') {
    const close = matchParen(objText, i);
    if (close < 0) return undefined;
    return { kind: 'code', value: objText.slice(i, close + 1), start: i, end: close + 1 };
  }
  // 标量/标识符：读到逗号或行尾（在对象文本内）
  let j = i;
  let depth = 0;
  while (j < objText.length) {
    const ch = objText[j];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if ((ch === ',' || ch === '}') && depth === 0) break;
    if (ch === ')' || ch === '}' || ch === ']') depth--;
    j++;
  }
  return { kind: 'code', value: objText.slice(i, j).trim(), start: i, end: j };
}

// 提取函数体（含 async）的源码文本：从 'function'/'=>' 起始位置截取完整函数
// 传入的值文本可能形如 `async function (a, b) { ... }` 或 `(a, b) => { ... }` 或 `async (a,b) => {...}`
function functionText(raw) {
  const s = raw.trim();
  const brace = s.indexOf('{');
  if (brace < 0) return undefined;
  const close = matchParen(s, brace);
  if (close < 0) return undefined;
  return s.slice(0, close + 1);
}

// 提取对象字面量中的方法简写：`async execute(args) { ... }` / `execute(args) { ... }`
// 返回 { kind: 'code', value: 'execute(args) { ... }', start, end } 或 undefined
function propertyMethod(objText, key) {
  const re = new RegExp('(?:^|[,\\s])(async\\s+)?' + key + '\\s*\\(');
  const m = re.exec(objText);
  if (!m) return undefined;
  const paramsStart = m.index + m[0].length - 1; // '(' 位置
  const paramsClose = matchParen(objText, paramsStart);
  if (paramsClose < 0) return undefined;
  let i = paramsClose + 1;
  while (i < objText.length && /\s/.test(objText[i])) i++;
  if (objText[i] !== '{') return undefined;
  const bodyClose = matchParen(objText, i);
  if (bodyClose < 0) return undefined;
  const start = m.index + (m[1] ? m[1].length : 0); // 从 key 开始（不含 async 前缀？保留 async）
  return {
    kind: 'code',
    value: objText.slice(start, bodyClose + 1),
    start,
    end: bodyClose + 1,
  };
}

// 求值 JS 对象字面量子集（单/双引号字符串、数字、布尔、null、undefined、数组、对象）
// 用于把 DSH 参数 schema（ParameterSchemaSpec）从源码文本解析为可用的 JSON。
function jsLiteralToValue(text) {
  const s = text.trim();
  if (s === '') return undefined;
  const p = new JsLiteralParser(s);
  const v = p.parseValue();
  if (!p.atEnd()) throw new Error('jsLiteral: 意外的尾随内容 @' + p.pos);
  return v;
}

class JsLiteralParser {
  constructor(text) {
    this.t = text;
    this.pos = 0;
  }
  atEnd() {
    while (this.pos < this.t.length && /\s/.test(this.t[this.pos])) this.pos++;
    return this.pos >= this.t.length;
  }
  peek() {
    while (this.pos < this.t.length && /\s/.test(this.t[this.pos])) this.pos++;
    return this.t[this.pos];
  }
  parseValue() {
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === "'" || c === '"') return this.parseString();
    if (c === 'u' && this.t.startsWith('undefined', this.pos)) { this.pos += 9; return undefined; }
    if (c === 'n' && this.t.startsWith('null', this.pos)) { this.pos += 4; return null; }
    if (c === 't' && this.t.startsWith('true', this.pos)) { this.pos += 4; return true; }
    if (c === 'f' && this.t.startsWith('false', this.pos)) { this.pos += 5; return false; }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.t.slice(this.pos));
    if (m) { this.pos += m[0].length; return Number(m[0]); }
    // 无法识别的表达式（变量、函数等）
    throw new Error('jsLiteral: 无法解析 @' + this.pos + ': ' + this.t.slice(this.pos, this.pos + 30));
  }
  parseString() {
    const quote = this.t[this.pos];
    this.pos++;
    let out = '';
    while (this.pos < this.t.length) {
      const c = this.t[this.pos];
      if (c === '\\') {
        const n = this.t[this.pos + 1];
        if (n === 'n') out += '\n';
        else if (n === 't') out += '\t';
        else if (n === 'r') out += '\r';
        else if (n === 'u') {
          out += String.fromCharCode(parseInt(this.t.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 4;
        } else out += n;
        this.pos += 2;
        continue;
      }
      if (c === quote) { this.pos++; return out; }
      out += c;
      this.pos++;
    }
    throw new Error('jsLiteral: 字符串未闭合');
  }
  parseArray() {
    this.pos++; // [
    const out = [];
    while (true) {
      const c = this.peek();
      if (c === ']') { this.pos++; return out; }
      out.push(this.parseValue());
      const c2 = this.peek();
      if (c2 === ',') { this.pos++; continue; }
      if (c2 === ']') { this.pos++; return out; }
      throw new Error('jsLiteral: 数组语法错误 @' + this.pos);
    }
  }
  parseObject() {
    this.pos++; // {
    const out = {};
    while (true) {
      const c = this.peek();
      if (c === '}') { this.pos++; return out; }
      // key: 标识符或字符串
      let key;
      if (c === "'" || c === '"') key = this.parseString();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.t.slice(this.pos));
        if (!m) throw new Error('jsLiteral: 对象键错误 @' + this.pos);
        key = m[0];
        this.pos += m[0].length;
      }
      while (this.pos < this.t.length && /\s/.test(this.t[this.pos])) this.pos++;
      if (this.t[this.pos] !== ':') throw new Error('jsLiteral: 缺冒号 @' + this.pos);
      this.pos++;
      out[key] = this.parseValue();
      const c2 = this.peek();
      if (c2 === ',') { this.pos++; continue; }
      if (c2 === '}') { this.pos++; return out; }
      throw new Error('jsLiteral: 对象语法错误 @' + this.pos);
    }
  }
}

module.exports = { findCalls, matchParen, propertyValue, propertyMethod, functionText, jsLiteralToValue, relativeImports };
