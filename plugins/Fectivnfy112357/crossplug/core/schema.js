// schema.js — JSON Schema ↔ typebox 相互转换（零依赖）
//
// dsh2mcode（插件代码模式）：JSON Schema → typebox 代码字符串
// mcode2dsh（桥接模式）：    typebox 运行时对象 → JSON Schema（鸭子类型识别）

'use strict';

// ── JSON Schema → typebox 代码 ──────────────────────────────────────────

function jsLiteral(v, indent) {
  return JSON.stringify(v, null, indent === undefined ? 0 : indent);
}

function isObjSchema(node) {
  return node && typeof node === 'object' && !Array.isArray(node) && typeof node.type === 'string';
}

// 把 JSON Schema 节点渲染成 typebox 表达式代码
function jsonSchemaToTypeboxCode(node, indent = '') {
  if (!isObjSchema(node)) {
    if (node && typeof node === 'object' && Array.isArray(node.oneOf)) {
      const branches = node.oneOf.map((b) => jsonSchemaToTypeboxCode(b, indent)).join(',\n' + indent + '  ');
      return `Type.Union([\n${indent}  ${branches}\n${indent}])`;
    }
    return 'Type.Any()';
  }
  const t = node.type;
  const opts = [];
  if (node.description) opts.push(`description: ${jsLiteral(node.description)}`);
  const optText = opts.length ? `{ ${opts.join(', ')} }` : '';
  switch (t) {
    case 'object': {
      const props = Object.entries(node.properties || {});
      const req = (node.required || []).filter((k) => (node.properties || {})[k]);
      if (req.length) opts.push(`required: ${jsLiteral(req)}`);
      if (node.additionalProperties === false) opts.push('additionalProperties: false');
      const optText2 = opts.length ? `{ ${opts.join(', ')} }` : '';
      if (!props.length) return `Type.Object({}${optText2 ? ', ' + optText2 : ''})`;
      const propsText = props
        .map(([k, v]) => `    ${JSON.stringify(k)}: ${jsonSchemaToTypeboxCode(v, indent + '  ')}`)
        .join(',\n');
      return `Type.Object({\n${propsText}\n  }${optText2 ? ', ' + optText2 : ''})`;
    }
    case 'array': {
      const items = node.items ? jsonSchemaToTypeboxCode(node.items, indent) : 'Type.Any()';
      return `Type.Array(${items}${optText ? ', ' + optText : ''})`;
    }
    case 'string': {
      if (node.enum && node.enum.length) {
        // mcode-plugin-spec.md §6.2：字符串枚举必须用 StringEnum（Type.Union/Literal
        // 的字符串枚举在 Google API 不工作）。typebox-shim.js 提供 Type.StringEnum。
        const enumText = `[${node.enum.map((e) => jsLiteral(e)).join(', ')}]`;
        return optText ? `Type.StringEnum(${enumText}, ${optText})` : `Type.StringEnum(${enumText})`;
      }
      return `Type.String(${optText})`;
    }
    case 'number':
      return `Type.Number(${optText})`;
    case 'integer':
      return `Type.Integer(${optText})`;
    case 'boolean':
      return `Type.Boolean(${optText})`;
    case 'null':
      return `Type.Null()`;
    default:
      return 'Type.Any()';
  }
}

// ── typebox 运行时对象 → JSON Schema ────────────────────────────────────

// typebox 的 .type 属性返回大写 Kind（'Object'/'String'/...），
// 普通 JSON Schema 的 type 是小写 —— 这是可靠的鸭子类型判据。
function looksTypebox(schema) {
  return (
    schema &&
    typeof schema === 'object' &&
    typeof schema.type === 'string' &&
    /^[A-Z]/.test(schema.type)
  );
}

function typeboxToJsonSchema(schema) {
  if (!looksTypebox(schema)) {
    // 已是普通 JSON Schema（或无法识别）——原样返回（只做浅拷贝防御）
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) return { ...schema };
    return {};
  }
  const kind = schema.type;
  const out = {};
  if (schema.description) out.description = schema.description;
  switch (kind) {
    case 'Object': {
      out.type = 'object';
      out.properties = {};
      for (const [k, v] of Object.entries(schema.properties || {})) {
        out.properties[k] = typeboxToJsonSchema(v);
      }
      if (Array.isArray(schema.required) && schema.required.length) out.required = [...schema.required];
      if (schema.additionalProperties !== undefined) out.additionalProperties = !!schema.additionalProperties;
      return out;
    }
    case 'Array':
      out.type = 'array';
      if (schema.items) out.items = typeboxToJsonSchema(schema.items);
      return out;
    case 'Union':
      if (Array.isArray(schema.anyOf) && schema.anyOf.length >= 2) {
        out.oneOf = schema.anyOf.map((b) => typeboxToJsonSchema(b));
        return out;
      }
      if (Array.isArray(schema.anyOf) && schema.anyOf.length === 1) return typeboxToJsonSchema(schema.anyOf[0]);
      return { type: 'object' };
    case 'Optional': {
      // Optional(T) 包裹：类型本身不强制 required
      return typeboxToJsonSchema(schema.anyOf && schema.anyOf.length ? schema.anyOf[0] : {});
    }
    case 'String':
      out.type = 'string';
      if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
        const literals = schema.anyOf
          .filter((b) => b && b.const !== undefined)
          .map((b) => b.const);
        if (literals.length) out.enum = literals;
      }
      return out;
    case 'Number':
      out.type = 'number';
      return out;
    case 'Integer':
      out.type = 'integer';
      return out;
    case 'Boolean':
      out.type = 'boolean';
      return out;
    case 'Null':
      out.type = 'null';
      return out;
    case 'Literal':
      if (schema.const !== undefined) {
        out.const = schema.const;
        out.type = typeof schema.const === 'number' ? (Number.isInteger(schema.const) ? 'integer' : 'number') : typeof schema.const === 'boolean' ? 'boolean' : 'string';
        return out;
      }
      return {};
    default:
      return { type: 'object' };
  }
}

// typebox 最小垫片源码（生成到输出包内，让转换产物零依赖自包含）
function typeboxShimCode() {
  return [
    '// 由 crossplug 生成的 typebox 最小垫片：只实现 schema 构造所需子集，',
    '// 运行时对象形态与 typebox 一致（大写 type 字段），供桥接器识别。',
    'function kind(t, props) { const s = { type: t, ...props }; return s; }',
    'export const Type = {',
    '  Object: (properties = {}, options = {}) => kind("Object", { properties, required: options.required || [], additionalProperties: options.additionalProperties }),',
    '  Array: (items, options = {}) => kind("Array", { items, ...(options.description ? { description: options.description } : {}) }),',
    '  String: (options = {}) => kind("String", { ...(options.description ? { description: options.description } : {}) }),',
    '  Number: (options = {}) => kind("Number", { ...(options.description ? { description: options.description } : {}) }),',
    '  Integer: (options = {}) => kind("Integer", { ...(options.description ? { description: options.description } : {}) }),',
    '  Boolean: (options = {}) => kind("Boolean", { ...(options.description ? { description: options.description } : {}) }),',
    '  Null: () => kind("Null", {}),',
    '  Any: () => kind("Any", {}),',
    '  Unknown: () => kind("Any", {}),',
    '  Literal: (value) => kind("Literal", { const: value }),',
    '  Union: (anyOf) => kind("Union", { anyOf }),',
    '  Optional: (inner) => kind("Optional", { anyOf: [inner] }),',
    '  StringEnum: (values, options = {}) => kind("String", { anyOf: (values || []).map((v) => ({ const: v })), ...(options && options.description ? { description: options.description } : {}) }),',
    '  Record: (key, value) => kind("Object", { properties: {}, additionalProperties: true }),',
    '};',
    '',
  ].join('\n');
}

// 供生成文件内联的紧凑版（桥接插件运行时使用）
const INLINE_BRIDGE_HELPERS = `
function tbToJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return {};
  if (typeof schema.type !== 'string' || !/^[A-Z]/.test(schema.type)) return { ...schema };
  const kind = schema.type;
  const out = {};
  if (schema.description) out.description = schema.description;
  switch (kind) {
    case 'Object': {
      out.type = 'object';
      out.properties = {};
      for (const k of Object.keys(schema.properties || {})) out.properties[k] = tbToJsonSchema(schema.properties[k]);
      if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.slice();
      if (schema.additionalProperties !== undefined) out.additionalProperties = !!schema.additionalProperties;
      return out;
    }
    case 'Array':
      out.type = 'array';
      if (schema.items) out.items = tbToJsonSchema(schema.items);
      return out;
    case 'Union':
      if (Array.isArray(schema.anyOf) && schema.anyOf.length === 1) return tbToJsonSchema(schema.anyOf[0]);
      if (Array.isArray(schema.anyOf) && schema.anyOf.length > 1) { out.oneOf = schema.anyOf.map(tbToJsonSchema); return out; }
      return { type: 'object' };
    case 'Optional':
      if (Array.isArray(schema.anyOf) && schema.anyOf.length) return tbToJsonSchema(schema.anyOf[0]);
      return { type: 'object' };
    case 'String': {
      out.type = 'string';
      // StringEnum(values) 在垫片里展开为 { type: 'String', anyOf: [{ const: v }] }：
      // 提取 const 列表作为 JSON Schema enum，保持枚举参数语义（mcode-plugin-spec.md §6.2）。
      if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
        const literals = schema.anyOf.filter((b) => b && b.const !== undefined).map((b) => b.const);
        if (literals.length) out.enum = literals;
      }
      return out;
    }
    case 'Number': out.type = 'number'; return out;
    case 'Integer': out.type = 'integer'; return out;
    case 'Boolean': out.type = 'boolean'; return out;
    case 'Null': out.type = 'null'; return out;
    default: return { type: 'object' };
  }
}
`;

module.exports = { jsonSchemaToTypeboxCode, typeboxToJsonSchema, looksTypebox, INLINE_BRIDGE_HELPERS, typeboxShimCode };
