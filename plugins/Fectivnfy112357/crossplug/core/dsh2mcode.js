// dsh2mcode.js — DSH 插件 → mcode（MiniMax Code / pi）插件包（零依赖）
//
// 两种输入：
//   1. DSH agent preset 目录（preset.yml + agent.cordis.yml [+ skills/]）
//      → 生成 mcode 插件包：package.json + extension.js（pi extension）+ 报告
//   2. DSH 插件源码文件（动态 Cordis 插件 / preset 本地插件 JS）
//      → 生成 pi extension：提取 registerTool/defineTool 与 ctx.on 并转写
//
// 转换是"脚手架 + 映射"，不是完全自动等价：无法映射的能力生成带说明的桩。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parsePreset } = require('./yaml.js');
const { classifyRow } = require('./mapping.js');
const { jsonSchemaToTypeboxCode, typeboxShimCode } = require('./schema.js');
const { findCalls, propertyValue, jsLiteralToValue } = require('./extract.js');

const TOOL_REGEXES = [
  /harness\.defineTool/g,
  /harness\.registerTool/g,
  /tools\.register/g,
  /defineTool/g,
  /registerTool/g,
];

// DSH 事件 ↔ pi 事件对照表（2026-08-14 对照 dsh-plugin-spec.md §9 权威会话事件词汇修正）
//
// DSH 侧事件分两类：
//   1. ctx.on 总线事件（插件直接监听，独立于会话日志）：
//        system-prompt/assemble、session/event、skills/change
//   2. session/event 流的子事件（ctx.on('session/event', (session, event))，
//      按 event.type 过滤，payload 在 event.data —— KNOWN_SESSION_EVENT_TYPES）：
//        turn/start、turn/end、step/start、step/end、user/message、
//        assistant/message、tool/call、tool/result、todo/write、
//        agent-preset/selected、command/run、command/done、compaction/* …
//
// pi 事件名以 mcode-plugin-spec.md §5.2 为准。
// bridgeKind：assembly = system-prompt/assemble 形态；turn-end = session/event(turn/end) 形态。
const EVENT_MAP = {
  // ── 1:1 可桥接（生成真正的 pi.on wrapper，调原 DSH handler）──
  'system-prompt/assemble': {
    pi: 'before_agent_start',
    bridge: true,
    bridgeKind: 'assembly',
    note: 'DSH host 平面每会话组装系统提示，handler(assembly, context, next) 往 assembly.sections.push({name, text})；pi 的 before_agent_start 在每轮 agent 循环前触发，返回 { systemPrompt } 即注入增补（mcode 文档 §5.2 1:1）',
  },
  'session/event': {
    pi: 'turn_end',
    bridge: true,
    bridgeKind: 'turn-end',
    note: 'DSH handler(session, event) 按 event.type 过滤子事件（turn/end 驱动 auto-retain 等）；pi 的 turn_end 在每轮 LLM 响应 + 工具调用完成后触发，桥接为 turn/end 子事件（mcode 文档 §5.2 1:1）',
  },
  // ── 弱对应（生成 stub；语义不直通，需人工移植）──
  'tool/call': { pi: 'tool_call', note: 'DSH 是会话日志子事件（event.type === "tool/call"，append-only 不可拦截）；pi 的 tool_call 可 block。语义不一致，生成 stub' },
  'tool/result': { pi: 'tool_result', note: 'DSH 是会话日志子事件（event.type === "tool/result"）；pi 的 tool_result 是 middleware 可改结果。语义不一致，生成 stub' },
  'user/message': { pi: 'message_start', note: 'DSH user/message 是用户消息落库子事件；pi message_start 是消息生命周期，弱对应' },
  'assistant/message': { pi: 'message_end', note: 'DSH assistant/message 是助手消息落库子事件；pi message_end 可替换消息，弱对应' },
  'turn/start': { pi: 'turn_start', note: 'DSH turn/start 开轮子事件；pi turn_start 每轮开始，弱对应' },
  'agent-preset/selected': { pi: 'model_select', note: 'DSH 会话切换 preset（仅日志）；pi model_select 模型切换，弱对应' },
  'compaction/start': { pi: 'session_before_compact', note: 'DSH 压缩开始子事件；pi 压缩前可取消/自定义 summary，概念对应' },
  'compaction/end': { pi: 'session_compact', note: 'DSH 压缩完成子事件；pi 压缩完成，概念对应' },
  'skills/change': { pi: 'resources_discover', note: 'DSH 技能目录变更失效通知（ctx.on 总线，emit 模式）；pi resources_discover 启动/重载时贡献 skillPaths（reason: startup|reload），目录级而非变更级，弱对应' },
  // ── 旧名兼容（deprecated：DSH 侧不存在这些事件，仅避免旧插件转换产物误报）──
  'tools/pre-execute': { pi: 'tool_call', note: '[deprecated 事件名] DSH 真实事件是 tool/call（session/event 子事件，append-only）；请源插件改用真实事件名' },
  'tools/result': { pi: 'tool_result', note: '[deprecated 事件名] DSH 真实事件是 tool/result；请源插件改用真实事件名' },
  'message/send': { pi: 'message_start', note: '[deprecated 事件名] DSH 真实事件是 user/message / assistant/message；请源插件改用真实事件名' },
};


// 从源文件提取插件 name 字段（兼容 export default { name: 'x' } 和 const name = 'x'）
function extractPluginName(source) {
  const re1 = /export\s+default\s*\{[\s\S]*?name\s*:\s*['"]([^'"]+)['"]/;
  const re2 = /(?:^|\n)\s*(?:const|let|var)\s+name\s*=\s*['"]([^'"]+)['"]/;
  const m1 = re1.exec(source);
  if (m1) return m1[1];
  const m2 = re2.exec(source);
  if (m2) return m2[1];
  return null;
}

// 从源文件提取 inject 字段
function extractInject(source) {
  const m = /inject\s*:\s*\[([^\]]*)\]/.exec(source);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// 把 DSH 非标准 schema 规范化成标准 JSON Schema
// DSH: { query: { type: 'string', required: true } }
// JSON Schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
function normalizeDshSchema(text) {
  if (!text || typeof text !== 'string') return null;
  let obj;
  try { obj = jsLiteralToValue(text); }
  catch { try { obj = JSON.parse(text); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  // 已经是标准 JSON Schema（有 type 字段）
  if (obj.type) return obj;
  // DSH 形态：每个属性自己带 type
  const props = {};
  const required = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && 'type' in v) {
      const { required: isReq, ...rest } = v;
      props[k] = rest;
      if (isReq === true) required.push(k);
    } else {
      props[k] = v;
    }
  }
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
}

function slugify(id) {
  return String(id || 'plugin')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'plugin';
}

// agent-plugins.org 插件名规则：/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
function makePluginName(humanName, fallbackId) {
  const ascii = String(humanName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  let name = ascii || slugify(fallbackId);
  if (!name) name = 'dsh-plugin';
  name = name.replace(/--+/g, '-').replace(/\.\.+/g, '.').replace(/[.-]$/g, '');
  if (!/^[a-z0-9]/.test(name)) name = 'd-' + name;
  return name;
}

// skill 目录名规则：/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/
function safeSkillName(name) {
  let n = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!n) n = 'skill';
  return n;
}

function writeFileSafe(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// ═══ 模式一：DSH agent preset → mcode 插件包 ═══

function convertPreset(srcDir, outDir) {
  const presetPath = path.join(srcDir, 'preset.yml');
  const compositionPath = path.join(srcDir, 'agent.cordis.yml');
  if (!fs.existsSync(presetPath)) throw new Error(`preset.yml 不存在: ${presetPath}`);
  if (!fs.existsSync(compositionPath)) throw new Error(`agent.cordis.yml 不存在: ${compositionPath}`);

  const preset = parsePreset(
    fs.readFileSync(presetPath, 'utf8'),
    fs.readFileSync(compositionPath, 'utf8'),
    { presetPath, compositionPath },
  );

  const id = slugify(preset.name || path.basename(srcDir));
  const pkgDir = outDir;
  const rows = preset.rows || [];
  const report = [];
  const srcSkills = path.join(srcDir, 'skills');

  // ── 分析行 → 能力 ──
  let personaText = '';
  const stubs = []; // { kind: 'tool'|'command', id, name, note, pi }
  const notes = [];

  for (const row of rows) {
    const mapping = classifyRow(row);
    const display = `${row.id} (${row.name})`;
    if (mapping.kind === 'persona') {
      // 从 config.text 取 persona（支持嵌套 configRows 里找 text）
      let text = '';
      if (typeof row.config === 'string') text = row.config;
      else if (row.config && typeof row.config === 'object') {
        if (row.config.text) text = row.config.text;
        if (row.config.__rows) {
          for (const sub of row.config.__rows) {
            if (sub.text && typeof sub.text === 'string') text += sub.text + '\n';
          }
        }
      }
      personaText = text || '';
      notes.push(`persona（${display}）：文本已写入 /persona 命令，${mapping.note}`);
    } else if (mapping.kind === 'tool') {
      stubs.push({ kind: 'tool', id: slugify(row.id), label: row.id, name: row.name, pi: mapping.pi, note: mapping.note });
      report.push(`[tool]  ${display} → ${mapping.pi}`);
    } else if (mapping.kind === 'command') {
      stubs.push({ kind: 'command', id: slugify(row.id), label: row.id, name: row.name, pi: mapping.pi, note: mapping.note });
      report.push(`[command] ${display} → ${mapping.pi}`);
    } else if (mapping.kind === 'warn') {
      notes.push(`⚠ ${display}：${mapping.pi}`);
      report.push(`[warn] ${display} → ${mapping.pi}`);
    } else {
      notes.push(`· ${display}：${mapping.pi}`);
      report.push(`[note] ${display} → ${mapping.pi}`);
    }
  }

  // ═══ 生成 AGENT_PLUGINS_V1 插件包（agent-plugins.org 1.0.0）═══
  // MCode（MiniMax Code）本地插件格式：根 plugin.json + skills/ + 可选 mcp.json，
  // 安装到 ~/.minimax/plugins/<name>/ 后出现在 /plugins 的 Local 标签页。
  const pluginName = makePluginName(preset.name, path.basename(srcDir));
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: pluginName,
    version: '0.1.0',
    description: (preset.description || `由 DSH agent preset「${preset.name || path.basename(srcDir)}」转换生成`).slice(0, 500),
    author: { name: 'crossplug' },
    keywords: ['dsh', 'converted', 'bridge'],
    extensions: {
      dshToMcode: {
        source: preset.meta.presetPath || srcDir,
        sourceKind: 'dsh-agent-preset',
        generatedAt: new Date().toISOString(),
      },
    },
  };
  writeFileSafe(path.join(pkgDir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

  // ── skills/ ──
  // 1) persona → skills/persona/SKILL.md（MCode 插件通过 skill 向 agent 提供知识）
  if (personaText) {
    writeFileSafe(path.join(pkgDir, 'skills', 'persona', 'SKILL.md'), [
      '---',
      'name: persona',
      'description: 来源 DSH agent preset「' + (preset.name || id) + '」的 persona 文本（转换参考）。',
      '---',
      '',
      '这是由 DSH agent preset 转换的插件。以下为来源 preset 的 persona（系统提示）原文：',
      '',
      '```text',
      personaText,
      '```',
      '',
    ].join('\n') + '\n');
  }
  // 2) preset 自带 skills/ 复制（目录名按 agent-plugins 规则规范化）
  if (fs.existsSync(srcSkills)) {
    for (const entry of fs.readdirSync(srcSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const safe = safeSkillName(entry.name);
      copyDir(path.join(srcSkills, entry.name), path.join(pkgDir, 'skills', safe));
      if (safe !== entry.name) {
        notes.push(`skill 目录「${entry.name}」重命名为 ${safe}（agent-plugins 名字规则）`);
      }
    }
  }
  // 3) 转换说明 skill
  writeFileSafe(path.join(pkgDir, 'skills', 'conversion-report', 'SKILL.md'), [
    '---',
    'name: conversion-report',
    'description: 本插件由 DSH agent preset 转换而来（脚手架+映射）。说明来源行与映射结论。',
    '---',
    '',
    '本插件由 crossplug 从 DSH agent preset 转换生成。',
    '插件能力承载方式为 skills（+可选的 mcp.json）。DSH preset 中的工具行无法',
    '直接映射为 MCode 插件工具（MCode 插件体系为 skills/MCP/apps），逐行映射见',
    '包内 CONVERSION-REPORT.md。来源 preset 的 persona 在 skills/persona/。',
    '',
  ].join('\n') + '\n');

  // ── 报告 / README ──
  writeFileSafe(path.join(pkgDir, 'CONVERSION-REPORT.md'), renderReport(preset, srcDir, report, personaText, stubs, notes));
  writeFileSafe(path.join(pkgDir, 'README.md'), [
    `# ${pluginName}`,
    '',
    `由 DSH agent preset「${preset.name || id}」转换生成（crossplug），agent-plugins.org 1.0.0 格式。`,
    '',
    '## 安装到 MiniMax Code（mcode）',
    '',
    '1. 把本目录复制/安装到 `~/.minimax/plugins/<name>/`（即本目录名）。',
    '2. 在 MiniMax Code 中打开 `/plugins`，切到 Local 标签页，找到本插件，按 Enter 安装。',
    '3. 安装后对话中可调用其 skills（persona / conversion-report / 来源 preset 的技能）。',
    '',
    '## 转换说明',
    '',
    '这是"脚手架 + 映射"结果：MCode 插件承载 skills/MCP/apps；DSH 的工具行无法',
    '自动移植为插件工具。逐行映射结论见 `CONVERSION-REPORT.md`。',
    '',
  ].join('\n') + '\n');

  return {
    kind: 'preset',
    source: srcDir,
    presetName: preset.name || id,
    out: pkgDir,
    packageName: pluginName,
    rows: rows.length,
    tools: stubs.filter((s) => s.kind === 'tool').length,
    commands: stubs.filter((s) => s.kind === 'command').length,
    notes: notes.length,
    reportFile: path.join(pkgDir, 'CONVERSION-REPORT.md'),
  };
}

function renderReport(preset, srcDir, report, personaText, stubs, notes) {
  const lines = [];
  lines.push(`# 转换报告：DSH preset → mcode 插件包`);
  lines.push('');
  lines.push(`- 来源: ${preset.meta.presetPath || srcDir}`);
  lines.push(`- 名称: ${preset.name || '-'}`);
  lines.push(`- 描述: ${preset.description || '-'}`);
  lines.push(`- 生成时间: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## 行映射');
  lines.push('');
  lines.push('| DSH 行 | 转换结果 |');
  lines.push('| --- | --- |');
  for (const r of report) lines.push(`| ${r.split(' → ')[0].replace(/\|/g, '\\|')} | ${(r.split(' → ').slice(1).join(' → ') || '').replace(/\|/g, '\\|')} |`);
  lines.push('');
  lines.push('## 桩工具 / 命令');
  lines.push('');
  for (const s of stubs) lines.push(`- \`${s.kind}\` \`${s.id}\`（来源 ${s.name}）：${s.pi}${s.note ? ' —— ' + s.note : ''}`);
  if (!stubs.length) lines.push('（无）');
  lines.push('');
  lines.push('## 说明项');
  lines.push('');
  for (const n of notes) lines.push(`- ${n}`);
  if (!notes.length) lines.push('（无）');
  lines.push('');
  if (personaText) {
    lines.push('## persona 文本');
    lines.push('');
    lines.push('```text');
    lines.push(personaText);
    lines.push('```');
  }
  return lines.join('\n') + '\n';
}

// ═══ 模式二：DSH 插件源码 → pi extension ═══

function convertPluginSource(srcFile, outDir, opts = {}) {
  const source = fs.readFileSync(srcFile, 'utf8');
  const base = path.basename(srcFile, path.extname(srcFile));
  const tools = [];
  const events = [];
  const lostCapabilities = [];
  const warnings = [];

  // ── 提取源插件的 name / inject（用于命名 plugin + 报告）──
  const sourcePluginName = extractPluginName(source);
  const sourceInject = extractInject(source);
  if (sourceInject && sourceInject.length) {
    warnings.push(`源插件声明 inject: [${sourceInject.join(', ')}]；本次只模拟 ${JSON.stringify(sourceInject.includes('tools') ? ['tools'] : sourceInject)}，其他服务（agents / effect / on）调用将不工作`);
  }

  // ── 提取工具注册 ──
  // harness.defineTool / harness.registerTool / tools.register / defineTool / registerTool
  const callRe = /(?:harness\.defineTool|harness\.registerTool|tools\.register|defineTool|registerTool)/g;
  const calls = findCalls(source, callRe).filter((c, i, arr) => {
    // 去重：跳过被更长模式（如 harness.defineTool 内的 defineTool）覆盖的匹配
    return i === 0 || c.start >= arr[i - 1].end;
  });
  for (const call of calls) {
    let args = call.argsText;
    // harness.registerTool(ctx, {...}) 之类的多参数调用：取第一个顶层 '{' 之后的部分
    if (!args.trim().startsWith('{')) {
      const braceIdx = firstTopLevelBrace(args);
      if (braceIdx >= 0) args = args.slice(braceIdx);
    }
    if (!args.trim().startsWith('{')) {
      warnings.push(`跳过非对象字面量的注册调用: ${args.slice(0, 60)}`);
      continue;
    }
    const name = propertyValue(args, 'name');
    const description = propertyValue(args, 'description');
    const parameters = propertyValue(args, 'parameters');
    if (!name || name.kind !== 'string') {
      warnings.push(`跳过缺少 name 的注册调用（可能 name 是变量）`);
      continue;
    }
    // 工具元数据保留下来（name/description/parameters）；
    // execute 不再字符串内联——改为 vendor 加载 + 模拟 ctx（见 mcp-server.js / extension.js 生成处）。
    tools.push({
      name: name.value,
      description: description && description.kind === 'string' ? description.value : '',
      parametersText: parameters && parameters.kind === 'code' ? parameters.value : '{}',
    });
  }

  // 2) ctx.on('event', ...) 事件 — 用独立 regex 抽取事件名（不走 findCalls/matchParen，
  //    因为含 lambda body 的 ctx.on 的 args 含 regex literal + '\u200b' 字符串，matchParen 词法分析扛不住）
  const EVENT_NAME_RE = /(?:ctx|host|agent|harness|engine)\.on\s*\(\s*(['"])([^'"]+)\1/g;
  for (const m of source.matchAll(EVENT_NAME_RE)) {
    const eventName = m[2];
    if (!eventName) continue;
    if (events.find((e) => e.event === eventName)) continue; // 去重
    const mapping = EVENT_MAP[eventName];
    events.push({ event: eventName });
    if (!mapping) {
      lostCapabilities.push(`ctx.on('${eventName}', ...)：mcode 无对应事件，自动触发该能力在转换后丢失（请改手动调用工具或保留 DSH 侧挂载）`);
      warnings.push(`事件 ${eventName} 无 mcode 对应，转换后该能力丢失`);
    } else if (mapping.bridge) {
      // 可桥接：会在 extension.js 里生成真正的 pi.on 包装，不算丢失
      warnings.push(`事件 ${eventName} → ${mapping.pi}（${mapping.note}）—— ⚠️ 桥接仅 pi/DSH 运行时有效；mcode CLI 不加载 pi extension，事件无消费者（2026-08-15 实证）`);
    } else {
      warnings.push(`事件 ${eventName} → ${mapping.pi}（${mapping.note}；当前生成 stub，需人工移植业务逻辑）`);
    }
  }

  if (tools.length === 0 && events.length === 0) {
    warnings.push('未识别到任何 tools.register / registerTool / ctx.on 调用，请人工检查源插件形态');
  }

  // ── 若提取到工具：同时生成 agent-plugins MCP 包（MCode /plugins 可直接安装）──
  let mcpPluginName;
  let mcpToolCount = 0;
  if (tools.length > 0) {
    // 优先用源 plugin 自带的 name 字段，其次用源文件名（去 dsh- 前缀）
    mcpPluginName = makePluginName(sourcePluginName || base.replace(/^dsh-/, '') || base, base);
    const serverName = sanitizeToolName(mcpPluginName) || 'tools';
    writeFileSafe(path.join(outDir, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: mcpPluginName,
      version: '0.1.0',
      description: `由 DSH 插件「${sourcePluginName || base}」转换：提供 ${tools.length} 个 MCP 工具（${tools.map((t) => t.name).join('、')}）。`,
      author: { name: 'crossplug' },
      keywords: ['dsh', 'converted', 'mcp'],
      extensions: { crossplug: { source: srcFile, sourceKind: 'dsh-plugin-tools', sourceName: sourcePluginName || undefined, generatedAt: new Date().toISOString() } },
    }, null, 2) + '\n');
    writeFileSafe(path.join(outDir, 'mcp.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        [serverName]: { type: 'stdio', command: 'node', args: ['./mcp-server.js'] },
      },
    }, null, 2) + '\n');
    // vendor/dsh-plugin.js 已经在下面 copyFileSync 写过了；mcp-server.js 用 import + 模拟 ctx 加载它
    writeFileSafe(path.join(outDir, 'mcp-server.js'), renderToolsMcpServer(tools, serverName, sourcePluginName || base));
    mcpToolCount = tools.length;
  }

  // ── 生成 extension.js ──
  // 关键变化：tools 不再"内联 execute 字符串"，而是 vendor 加载原插件 + 模拟 ctx，让 apply() 内部注册的工具被收集，然后逐个 pi.registerTool 派发。
  // 闭包（cfg / recall / formatRecall 等）保留在原 apply 作用域里，工具行为真实。
  const lines = [];
  lines.push('// 由 DSH 插件源码转换生成 — 源: ' + srcFile);
  lines.push('// 生成时间: ' + new Date().toISOString());
  lines.push('// 转换器: crossplug (core/dsh2mcode.js, plugin-source 模式)');
  lines.push('//');
  lines.push('// 工具执行走 vendor/dsh-plugin.js 加载 + 模拟 ctx 路径，');
  lines.push('// 闭包（cfg / recall / formatRecall 等）保留在原 apply() 作用域里，行为真实。');
  lines.push('');
  lines.push('import dshPlugin from "./vendor/dsh-plugin.js";');
  lines.push('import { Type } from "./typebox-shim.js";');
  lines.push('');
  lines.push('// DSH 工具注册的元数据缓存（mockCtx.tools.register 时写入）');
  // 镜像块：与 renderToolsMcpServer 模板中的 mockTools/mockCtx 保持一致（改动需两侧同步）
  lines.push('const mockTools = {');
  lines.push('  registered: new Map(),');
  lines.push('  register(spec) {');
  lines.push('    this.registered.set(spec.name, spec);');
  lines.push('    return () => this.registered.delete(spec.name);');
  lines.push('  },');
  lines.push('};');
  lines.push('');
  lines.push('// 模拟 DSH ctx：tools 真注册；on() 记录 handler（不丢弃），供 before_agent_start 等桥接 wrapper 调');
  lines.push('const mockCtx = {');
  lines.push('  get(name) {');
  lines.push('    if (name === "tools") return mockTools;');
  lines.push('    if (name === "agents") return { currentInitiator: () => null };');
  lines.push('    return undefined;');
  lines.push('  },');
  lines.push('  _listeners: {},');
  lines.push('  on(event, handler) {');
  lines.push('    (this._listeners[event] || (this._listeners[event] = [])).push(handler);');
  lines.push('  },');
  lines.push('  effect(fn) { try { fn(); } catch {} },');
  lines.push('}');
  lines.push('');
  lines.push('// 触发原 DSH 插件 apply，populate mockTools');
  lines.push('try {');
  lines.push('  // ESM 命名空间对象：真实默认导出在 .default；要兼容：default 是函数 / default 是 { apply } / 直接是函数 / 直接是 { apply }');
  lines.push('  const target = (dshPlugin && dshPlugin.default) ? dshPlugin.default : dshPlugin;');
  lines.push('  if (typeof target === "function") target(mockCtx, {});');
  lines.push('  else if (target && typeof target.apply === "function") target.apply(mockCtx, {});');
  lines.push('  else throw new Error("vendor 没有 default 导出且无 apply 方法（既不是函数也不是带 apply 的对象）");');
  lines.push('} catch (err) {');
  lines.push('  console.error("[crossplug] vendor apply 抛错: " + (err && err.message ? err.message : err));');
  lines.push('}');
  lines.push('');
  lines.push('export default function (pi) {');
  lines.push('');

  for (const t of tools) {
    let typeboxCode = 'Type.Any()';
    let schemaNote = '';
    const norm = normalizeDshSchema(t.parametersText);
    if (norm) {
      try {
        typeboxCode = jsonSchemaToTypeboxCode(norm);
      } catch {
        schemaNote = '  // 参数 schema 规范化后仍无法生成 typebox，已用 Type.Any() 兜底';
      }
    } else {
      schemaNote = '  // 参数 schema 无法解析为 JS 字面量/JSON，已用 Type.Any() 兜底';
    }
    lines.push(`  // ── 工具 ${t.name} ──`);
    if (schemaNote) lines.push(schemaNote);
    lines.push(`  pi.registerTool({`);
    lines.push(`    name: ${JSON.stringify(t.name.replace(/[^A-Za-z0-9_]/g, '_'))},`);
    lines.push(`    label: ${JSON.stringify(t.name)},`);
    lines.push(`    description: ${JSON.stringify(t.description || '（无描述）')},`);
    lines.push(`    parameters: ${typeboxCode},`);
    lines.push(`    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {`);
    lines.push(`      // 从 mockTools 拿原 DSH 工具 spec（vendor apply 已注册），派发到原 execute(args)`);
    lines.push(`      const spec = mockTools.registered.get(${JSON.stringify(t.name)});`);
    lines.push(`      if (!spec || typeof spec.execute !== "function") {`);
    lines.push(`        return { content: [{ type: "text", text: ${JSON.stringify('[crossplug] 原工具 ' + t.name + ' 在 vendor 加载阶段未注册到 tools')} }], details: {} };`);
    lines.push(`      }`);
    lines.push(`      try {`);
    lines.push(`        // 第二参 exec 上下文（callId/signal）传给原工具，保持 DSH 工具契约`);
    lines.push(`        const raw = await spec.execute(params, { callId: toolCallId, signal: _signal });`);
    lines.push(`        // 适配 DSH 的 output.render（如有）或直接走 text 通道`);
    lines.push(`        if (spec.output && typeof spec.output.render === "function") {`);
    lines.push(`          const rendered = spec.output.render(params, raw);`);
    lines.push(`          if (Array.isArray(rendered)) return { content: rendered, details: { raw } };`);
    lines.push(`        }`);
    lines.push(`        if (raw && typeof raw === "object" && Array.isArray(raw.content)) return { content: raw.content, details: raw.details || {} };`);
    lines.push(`        const text = raw && typeof raw === "object" && typeof raw.text === "string" ? raw.text : (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));`);
    lines.push(`        return { content: [{ type: "text", text }], details: { raw } };`);
    lines.push(`      } catch (err) {`);
    lines.push(`        return { content: [{ type: "text", text: ${JSON.stringify('[crossplug] ' + t.name + ' 执行失败: ') + ' + (err && err.message ? err.message : String(err))'} }], details: {} };`);
    lines.push(`      }`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push('');
  }

  for (const ev of events) {
    const mapped = EVENT_MAP[ev.event];
    if (mapped && mapped.bridge) {
      if (mapped.bridgeKind === 'turn-end') {
        // 桥接 pi turn_end → DSH session/event（turn/end 子事件）。
        // DSH handler 签名 (session, event)，按 event.type 过滤；payload 在 event.data。
        // 注：mockSession 是占位（无真实消息），deriveMessages 返回空 —— 需要完整消息的
        // handler 需人工适配（见 doc/event-mapping-questions.md）。
        lines.push(`  // ── 事件 ${ev.event}(turn/end) → pi.${mapped.pi}（桥接：把 pi turn_end 转成 DSH turn/end 子事件）──`);
        lines.push(`  pi.on(${JSON.stringify(mapped.pi)}, async (event, _ctx) => {`);
        lines.push(`    const handlers = (mockCtx._listeners && mockCtx._listeners[${JSON.stringify(ev.event)}]) || [];`);
        lines.push(`    if (!handlers.length) return;`);
        lines.push(`    // DSH session/event handler 收到 (session, event)，按 event.type === "turn/end" 过滤`);
        lines.push(`    // Q2 答复：pi turn_end 事件含 message（AgentMessage），传给 DSH handler 的 session.deriveMessages()`);
        lines.push(`    const mockSession = { id: "bridged", deriveMessages: () => {`);
        lines.push(`      const m = event && event.message;`);
        lines.push(`      if (m === undefined || m === null) return [];`);
        lines.push(`      if (Array.isArray(m)) return m;`);
        lines.push(`      return [typeof m === "string" ? { role: "assistant", content: [{ type: "text", text: m }] } : m];`);
        lines.push(`    } };`);
        lines.push(`    // Q2 答复：pi turn_end 事件含 turnIndex（轮次序号），传给 DSH turn/end 的 data.turn`);
        lines.push(`    const dshEvent = { type: "turn/end", seq: 0, time: Date.now(), data: { turn: (event && event.turnIndex !== undefined) ? event.turnIndex : 0, reason: { kind: "completed" } } };`);
        lines.push(`    for (const handler of handlers) {`);
        lines.push(`      try {`);
        lines.push(`        await handler(mockSession, dshEvent);`);
        lines.push(`      } catch (err) {`);
        lines.push(`        console.error("[crossplug] " + ${JSON.stringify(ev.event)} + " handler 抛错: " + (err && err.message ? err.message : err));`);
        lines.push(`      }`);
        lines.push(`    }`);
        lines.push(`  });`);
        lines.push('');
      } else {
        // bridgeKind === 'assembly'：桥接 DSH (assembly, context, next) → pi before_agent_start。
        // DSH handler 往 assembly.sections.push({name, text})；pi 返回 { systemPrompt } 注入增补。
        lines.push(`  // ── 事件 ${ev.event} → pi.${mapped.pi}（桥接：调原 DSH handler）──`);
        lines.push(`  pi.on(${JSON.stringify(mapped.pi)}, async (event, _ctx) => {`);
        lines.push(`    const handlers = (mockCtx._listeners && mockCtx._listeners[${JSON.stringify(ev.event)}]) || [];`);
        lines.push(`    if (!handlers.length) return;`);
        lines.push(`    // 模拟 DSH 的 assembly：原 handler 会往 assembly.sections.push({name, text})`);
        lines.push(`    const assembly = { sections: [] };`);
        lines.push(`    const fakeContext = { scope: { _marker: true } };`);
        lines.push(`    for (const handler of handlers) {`);
        lines.push(`      try {`);
        lines.push(`        await handler(assembly, fakeContext, () => {});`);
        lines.push(`      } catch (err) {`);
        lines.push(`        console.error("[crossplug] " + ${JSON.stringify(ev.event)} + " handler 抛错: " + (err && err.message ? err.message : err));`);
        lines.push(`      }`);
        lines.push(`    }`);
        lines.push(`    if (!assembly.sections.length) return;`);
        lines.push(`    // 把 DSH 注入的 sections 合并成 system prompt 增补`);
        lines.push(`    const injected = assembly.sections.map((s) => s.text || "").join("\\n\\n");`);
        lines.push(`    const base = (event && typeof event.systemPrompt === "string") ? event.systemPrompt : "";`);
        lines.push(`    return { systemPrompt: base + (base ? "\\n\\n" : "") + injected };`);
        lines.push(`  });`);
        lines.push('');
      }
    } else if (mapped) {
      // 有映射但不可桥接：保留 stub
      lines.push(`  // ── 事件 ${ev.event} → pi.${mapped.pi}（${mapped.note}；语义不直通，需人工移植）──`);
      lines.push(`  pi.on(${JSON.stringify(mapped.pi)}, async (_event, _ctx) => {`);
      lines.push(`    // 原 DSH 处理逻辑需人工移植（事件语义不 1:1）`);
      lines.push(`  });`);
      lines.push('');
    } else {
      lines.push(`  // ⚠ 事件 ${ev.event} 无 mcode/pi 对应，已跳过（能力在转换后丢失）`);
      lines.push('');
    }
  }

  if (!tools.length && !events.length) {
    lines.push(`  // ⚠ 未在源码中识别到 tools.register 或 ctx.on 调用。`);
    lines.push(`  // 原插件源码完整保留在 vendor/ 目录，请人工移植。`);
    lines.push('');
  }

  lines.push('}');
  lines.push('');

  const pkgName = `dsh-plugin-${slugify(sourcePluginName || base)}-bridge`;
  writeFileSafe(path.join(outDir, 'extension.js'), lines.join('\n'));
  writeFileSafe(path.join(outDir, 'typebox-shim.js'), typeboxShimCode());
  writeFileSafe(path.join(outDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version: '0.1.0',
    description: `由 DSH 插件源码 ${path.basename(srcFile)} 转换生成的 pi extension`,
    type: 'module',
    main: 'extension.js',
    dependencies: { typebox: '*' },
    dshToMcode: { source: srcFile, sourceKind: 'dsh-plugin-source', generatedAt: new Date().toISOString() },
  }, null, 2) + '\n');
  // 保留原源码作 vendor 加载源
  fs.mkdirSync(path.join(outDir, 'vendor'), { recursive: true });
  // 用固定名 dsh-plugin.js 以便 mcp-server.js / extension.js 可以稳定 import
  fs.copyFileSync(srcFile, path.join(outDir, 'vendor', 'dsh-plugin.js'));
  writeFileSafe(path.join(outDir, 'CONVERSION-REPORT.md'), [
    `# 转换报告：DSH 插件源码 → mcode 插件包`,
    '',
    `- 来源: ${srcFile}`,
    `- 源 plugin name: ${sourcePluginName || '（未识别，使用文件名 ' + base + '）'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    '',
    `## 工具（${tools.length}）`,
    '',
    ...tools.map((t) => `- \`${t.name}\`（execute 走 vendor 模拟 ctx 调用，闭包保留）${t.description ? '：' + t.description : ''}`),
    '',
    `## 事件（${events.length}）`,
    '',
    ...events.map((e) => `- \`${e.event}\`${EVENT_MAP[e.event] ? ' → pi.' + EVENT_MAP[e.event].pi : ' → ❌ 丢失（无 mcode/pi 对应）'}${e.event === 'session/event' ? '（仅 turn/end 子事件桥接；turn/start、tool/call、tool/result、user/message、assistant/message 等子事件不桥接）' : ''}`),
    '',
    `## 丢失能力`,
    '',
    ...(lostCapabilities.length
      ? lostCapabilities.map((c) => `- ${c}`)
      : ['（无）']),
    '',
    `## 产物`,
    '',
    ...(mcpPluginName
      ? [`- agent-plugins MCP 包：\`plugin.json\` + \`mcp.json\` + \`mcp-server.js\`（${mcpToolCount} 个 MCP 工具）→ 复制到 ~/.minimax/plugins/${mcpPluginName}/，MCode /plugins → Local 安装`]
      : []),
    [`- vendor：原 DSH 插件源码 \`vendor/dsh-plugin.js\`（被 mcp-server.js / extension.js 加载）`],
    [`- pi extension：\`extension.js\` + \`typebox-shim.js\` —— ⚠️ 仅独立 pi CLI 生效；mcode CLI 不加载 pi extension（2026-08-15 实证，mcode-plugin-spec.md §1.1）；mcode 侧生效载体是上面的 agent-plugins MCP 包`],
    '',
    `## 警告`,
    '',
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['（无）']),
    '',
  ].join('\n') + '\n');

  return {
    kind: 'plugin-source',
    source: srcFile,
    out: outDir,
    packageName: pkgName,
    mcpPluginName: mcpPluginName || undefined,
    mcpTools: mcpToolCount,
    tools: tools.length,
    events: events.length,
    warnings: warnings.length,
    reportFile: path.join(outDir, 'CONVERSION-REPORT.md'),
  };
}

// 工具注册型插件 → MCP stdio 服务器（newline JSON-RPC）
// vendor 加载 + 模拟 ctx：原 DSH 插件的 execute 闭包完整保留（cfg / recall / formatRecall 等不变）
function renderToolsMcpServer(tools, serverName, sourceBase) {
  // MCP 广播名（sanitized）→ vendor 注册的原始工具名：MCP 客户端按广播名调用，
  // 派发时必须还原原始名查 mockTools.registered（原名可含 - 等 MCP 广播不允许的字符）。
  const nameMap = {};
  const toolDefs = tools.map((t) => {
    let inputSchema = { type: 'object', properties: {} };
    const norm = normalizeDshSchema(t.parametersText);
    if (norm && typeof norm === 'object') inputSchema = norm;
    const safeName = String(t.name).replace(/[^A-Za-z0-9_]/g, '_');
    nameMap[safeName] = t.name;
    return {
      name: safeName,
      description: t.description || `由 DSH 插件「${sourceBase}」转换的工具（crossplug 桥接）`,
      inputSchema,
    };
  });

  // 不再内联 execute 字符串；用 mockTools.registered 派发到 vendor 加载的原 spec
  return `#!/usr/bin/env node
// 由 crossplug 生成：把 DSH 插件（${sourceBase}）的工具注册桥接为 MCP stdio 服务器。
// 协议：newline-delimited JSON-RPC 2.0（initialize / tools/list / tools/call / ping / notifications/*）。
// 执行路径：vendor/dsh-plugin.js → mockCtx.tools.register → mockTools.registered → 本文件派发。
// 闭包（cfg / recall / formatRecall 等）保留在原 apply() 作用域里。
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载原 DSH 插件（ESM）
const dshPlugin = await import(pathToFileURL(resolvePath(__dirname, "./vendor/dsh-plugin.js")).href);

// 镜像块：与 convertPluginSource 生成的 extension.js 中的 mockTools/mockCtx 保持一致（改动需两侧同步）
// DSH 工具注册表（apply() 触发后填充）
const mockTools = {
  registered: new Map(),
  register(spec) {
    this.registered.set(spec.name, spec);
    return () => this.registered.delete(spec.name);
  },
};

// 模拟 DSH ctx：tools 真注册；on() 记录 handler（不丢弃），供桥接 wrapper 调用
const mockCtx = {
  get(name) {
    if (name === "tools") return mockTools;
    if (name === "agents") return { currentInitiator: () => null };
    return undefined;
  },
  _listeners: {},
  on(event, handler) {
    (this._listeners[event] || (this._listeners[event] = [])).push(handler);
  },
  effect(fn) { try { fn(); } catch {} },
};

// 触发原 DSH 插件 apply
// ESM 命名空间对象：真实默认导出在 .default；要兼容：default 是函数 / default 是 { apply } / 直接是函数 / 直接是 { apply }
try {
  const target = (dshPlugin && dshPlugin.default) ? dshPlugin.default : dshPlugin;
  if (typeof target === "function") target(mockCtx, {});
  else if (target && typeof target.apply === "function") target.apply(mockCtx, {});
  else throw new Error("vendor 没有 default 导出且无 apply 方法（既不是函数也不是带 apply 的对象）");
} catch (err) {
  process.stderr.write("[crossplug] vendor apply 抛错: " + (err && err.message ? err.message : err) + "\\n");
}

const TOOLS = ${JSON.stringify(toolDefs, null, 2)};

// 广播名 → 原始注册名（名字含 - 等字符的工具经此还原）
const NAME_MAP = ${JSON.stringify(nameMap, null, 2)};

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "crossplug-${serverName}", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // 通知类：无需回复
    } else if (method === "ping") {
      respond(id, {});
    } else if (method === "tools/list") {
      respond(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const originalName = NAME_MAP[name] || name;
      const spec = mockTools.registered.get(originalName);
      if (!spec || typeof spec.execute !== "function") {
        return respondError(id, -32602, "unknown tool or tool not registered by vendor: " + name);
      }
      try {
        // 第二参 exec 上下文：MCP 无 callId/signal，传 undefined 保持 DSH 工具契约（工具内可选链安全）
        const raw = await spec.execute(args, { callId: undefined, signal: undefined });
        let text;
        if (spec.output && typeof spec.output.render === "function") {
          const rendered = spec.output.render(args, raw);
          if (Array.isArray(rendered)) {
            text = rendered.map((c) => (c && typeof c.text === "string" ? c.text : JSON.stringify(c))).join("\\n");
          } else {
            text = JSON.stringify(rendered);
          }
        } else if (raw && typeof raw === "object" && typeof raw.text === "string") {
          text = raw.text;
        } else if (typeof raw === "string") {
          text = raw;
        } else {
          text = JSON.stringify(raw, null, 2);
        }
        respond(id, { content: [{ type: "text", text: text || "（空结果）" }] });
      } catch (err) {
        respondError(id, -32603, "[crossplug] tool execute failed: " + (err && err.message ? err.message : String(err)));
      }
    } else {
      respondError(id, -32601, "method not found: " + method);
    }
  } catch (e) {
    respondError(id, -32603, String(e && e.message ? e.message : e));
  }
});
`;
}

// 向上查找源插件的 package.json，取其 name
function findPluginPackageName(srcFile) {
  let dir = path.dirname(srcFile);
  for (let i = 0; i < 3; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim();
      } catch { /* 忽略坏 package.json */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// MCP 工具名：小写下划线，去掉 dsh-/web-search/-provider 等词缀
function sanitizeToolName(name) {
  return String(name)
    .toLowerCase()
    .replace(/^dsh-/, '')
    .replace(/^web-?search-/, '')
    .replace(/-web-?search/, '')
    .replace(/-provider$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'search';
}


function indentCode(code, pad) {
  return code
    .split('\n')
    .map((l) => (l === '' ? '' : ' '.repeat(pad) + l))
    .join('\n');
}

// 找第一个不在字符串/注释中的 '{'（用于多参数调用中定位对象字面量）
function firstTopLevelBrace(text) {
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (state === 'str-single') {
      if (c === '\\') i++;
      else if (c === "'") state = 'code';
      continue;
    }
    if (state === 'str-double') {
      if (c === '\\') i++;
      else if (c === '"') state = 'code';
      continue;
    }
    if (state === 'line-comment') {
      if (c === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (c === '*' && n === '/') { state = 'code'; i++; }
      continue;
    }
    if (c === "'") { state = 'str-single'; continue; }
    if (c === '"') { state = 'str-double'; continue; }
    if (c === '/' && n === '/') { state = 'line-comment'; i++; continue; }
    if (c === '/' && n === '*') { state = 'block-comment'; i++; continue; }
    if (c === '{') return i;
  }
  return -1;
}

// ═══ 模式三：DSH 搜索提供方插件（registerSearchProvider）→ agent-plugins MCP 包 ═══
//
// 把 ctx.web.registerSearchProvider(...) 型插件转换为 MCode 可安装的
// agent-plugins.org 1.0.0 插件包：原插件 vendor 进 vendor/（@deepseek-ai 依赖
// 重写为本地垫片），生成 mcp-server.js（stdio JSON-RPC）把 provider.search()
// 暴露为 MCP 工具 searxng_search，mcp.json 声明 MCP 服务器。

// @deepseek-ai 依赖 → 本地垫片文件名映射
const DSH_IMPORT_SHIMS = {
  '@deepseek-ai/schemastery': 'schemastery-shim.js',
  '@deepseek-ai/dsh-web': 'dsh-web-shim.js',
  '@deepseek-ai/dsh-launch-environment': 'launch-env-shim.js',
};

function shimSourceFor(pkg) {
  if (pkg === '@deepseek-ai/schemastery') {
    return [
      '// 由 crossplug 生成的 schemastery 最小垫片：链式方法全部空操作，',
      '// 只满足 Config 声明在模块顶层的求值（运行时校验由宿主负责）。',
      'function chainable(target) {',
      '  return new Proxy(target || {}, {',
      '    get(t, prop) {',
      '      if (prop in t) return t[prop];',
      '      if (typeof prop === "symbol") return undefined;',
      '      return () => chainable(t);',
      '    },',
      '  });',
      '}',
      'const z = {',
      '  object: (shape) => chainable({ type: "object", shape }),',
      '  string: () => chainable({ type: "string" }),',
      '  number: () => chainable({ type: "number" }),',
      '  integer: () => chainable({ type: "integer" }),',
      '  boolean: () => chainable({ type: "boolean" }),',
      '  array: (item) => chainable({ type: "array", item }),',
      '  optional: (v) => v,',
      '  union: (v) => chainable({ type: "union", anyOf: v }),',
      '  literal: (v) => chainable({ type: "literal", const: v }),',
      '};',
      'export default z;',
      '',
    ].join('\n');
  }
  if (pkg === '@deepseek-ai/dsh-web') {
    return [
      '// 由 crossplug 生成的 dsh-web 最小垫片：WebError 保持错误码语义。',
      'export class WebError extends Error {',
      '  constructor(message, code, options) {',
      '    super(message);',
      '    this.name = "WebError";',
      '    this.code = code;',
      '    if (options && options.cause !== undefined) this.cause = options.cause;',
      '  }',
      '}',
      '',
    ].join('\n');
  }
  if (pkg === '@deepseek-ai/dsh-launch-environment') {
    return [
      '// 由 crossplug 生成的 launch-environment 垫片：从 process.env 读取受管变量。',
      'export function launchEnvironmentOf() {',
      '  return {',
      '    get(name) {',
      '      const value = process.env[name] || "";',
      '      return value ? { value } : undefined;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n');
  }
  return undefined;
}

// 重写 vendor 源码：@deepseek-ai 依赖指向本地垫片；其他 @deepseek-ai/@earendil-works 导入注释掉
function rewriteProviderImports(source, warnings) {
  let out = source;
  const used = new Set();
  const lineRe = /^(\s*import\s+[^\n]*?from\s+["'])(@deepseek-ai\/[^"']+|@earendil-works\/[^"']+)(["'][^\n]*)$/gm;
  out = out.replace(lineRe, (whole, head, pkg, tail) => {
    if (DSH_IMPORT_SHIMS[pkg]) {
      used.add(pkg);
      return `${head}./${DSH_IMPORT_SHIMS[pkg]}${tail}`;
    }
    warnings.push(`移除了无法解析的运行时导入 ${pkg}（桥接环境不提供，相关逻辑需人工核对）`);
    return `// [crossplug] removed import: ${whole.trim().slice(0, 120)}`;
  });
  // 裸导入（无 from）：import "@deepseek-ai/xxx"
  out = out.replace(/^(\s*import\s+["'])(@deepseek-ai\/[^"']+|@earendil-works\/[^"']+)(["'][^\n]*)$/gm, (whole, head, pkg, tail) => {
    warnings.push(`移除了无法解析的裸导入 ${pkg}`);
    return `// [crossplug] removed bare import: ${whole.trim().slice(0, 120)}`;
  });
  return { source: out, used };
}

function renderMcpServer(toolName, description) {
  return `#!/usr/bin/env node
// 由 crossplug 生成：把 DSH 搜索提供方插件（registerSearchProvider）包装为 MCP stdio 服务器。
// 协议：newline-delimited JSON-RPC 2.0（initialize / tools/list / tools/call / ping）。
// SearXNG 地址从环境变量 SEARXNG_URL 读取（由 mcp.json 的 env 注入）。
import { createInterface } from "node:readline";
import { apply } from "./vendor/index.js";

let provider = null;
apply(
  {
    web: {
      registerSearchProvider(p) {
        provider = p;
      },
    },
  },
  {
    url: process.env.SEARXNG_URL || "",
    maxResults: 30,
    categories: "",
    language: "",
    timeoutMs: 20000,
  },
);

const TOOLS = [
  {
    name: ${JSON.stringify(toolName)},
    description: ${JSON.stringify(description)},
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询" },
        categories: { type: "string", description: "逗号分隔的分类（如 news,it）" },
        language: { type: "string", description: "语言提示；缺省自动检测" },
        maxResults: { type: "integer", description: "最大结果数（缺省 30）" },
      },
      required: ["query"],
    },
  },
];

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "crossplug-searxng", version: "1.0.0" },
      });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // 通知类：无需回复
    } else if (method === "ping") {
      respond(id, {});
    } else if (method === "tools/list") {
      respond(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (name !== TOOLS[0].name) return respondError(id, -32602, "unknown tool: " + name);
      if (!provider) return respondError(id, -32603, "SearXNG provider 未就绪：请设置 SEARXNG_URL（mcp.json env 或系统环境变量）");
      const signal = new AbortController().signal;
      const result = await provider.search({ query: args.query }, signal);
      const text = (result.sources || [])
        .map((s) => "- " + (s.title || s.url) + "\\n  " + s.url + (s.snippet ? "\\n  " + s.snippet : ""))
        .join("\\n");
      respond(id, { content: [{ type: "text", text: text || "（无结果）" }] });
    } else {
      respondError(id, -32601, "method not found: " + method);
    }
  } catch (e) {
    respondError(id, -32603, String(e && e.message ? e.message : e));
  }
});
`;
}

function convertProviderPlugin(srcFile, outDir) {
  const source = fs.readFileSync(srcFile, 'utf8');
  const warnings = [];
  const base = path.basename(srcFile, path.extname(srcFile));
  // 插件真实名字：优先从源插件包 package.json 提取（srcFile 可能在 lib/ 子目录）
  const pkgName = findPluginPackageName(srcFile);
  const pluginName = makePluginName(pkgName || base, base);
  const toolName = sanitizeToolName(pluginName) + '_search';
  const pkgDir = outDir;

  // ── vendor：原插件 + import 重写 + 垫片 ──
  const rewritten = rewriteProviderImports(source, warnings);
  fs.mkdirSync(path.join(pkgDir, 'vendor'), { recursive: true });
  writeFileSafe(path.join(pkgDir, 'vendor', 'index.js'), rewritten.source);
  for (const pkg of Object.keys(DSH_IMPORT_SHIMS)) {
    if (rewritten.used.has(pkg)) {
      writeFileSafe(path.join(pkgDir, 'vendor', DSH_IMPORT_SHIMS[pkg]), shimSourceFor(pkg));
    }
  }

  // ── MCP 服务器 ──
  const description = `通过 SearXNG 实例搜索网页（由 DSH 插件「${pluginName}」转换，crossplug 桥接）。`;
  writeFileSafe(path.join(pkgDir, 'mcp-server.js'), renderMcpServer(toolName, description));

  // ── mcp.json（agent-plugins 1.0.0）──
  const searxngUrl = process.env.SEARXNG_URL || '';
  const mcp = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      [toolName]: {
        type: 'stdio',
        command: 'node',
        args: ['./mcp-server.js'],
        env: { SEARXNG_URL: searxngUrl },
      },
    },
  };
  writeFileSafe(path.join(pkgDir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  if (!searxngUrl) {
    warnings.push('本机未设置 SEARXNG_URL：请在 mcp.json 的 env 或系统环境变量中配置 SearXNG 实例地址');
  }

  // ── plugin.json（agent-plugins 1.0.0）──
  writeFileSafe(path.join(pkgDir, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: pluginName,
    version: '1.0.0',
    description: `由 DSH 插件「${pluginName}」转换：提供 SearXNG 网页搜索（MCP 工具 ${toolName}）。`,
    author: { name: 'crossplug' },
    keywords: ['dsh', 'converted', 'search', 'searxng'],
    extensions: {
      crossplug: { source: srcFile, sourceKind: 'dsh-search-provider', generatedAt: new Date().toISOString() },
    },
  }, null, 2) + '\n');

  // ── 说明 skill + 报告 + README ──
  writeFileSafe(path.join(pkgDir, 'skills', 'search-notes', 'SKILL.md'), [
    '---',
    'name: search-notes',
    'description: 本插件由 DSH 搜索提供方插件「' + base + '」转换而来：提供 SearXNG 网页搜索（MCP 工具 ' + toolName + '）。',
    '---',
    '',
    '本插件把 DSH 的 SearXNG 搜索提供方桥接为 MCP 工具。',
    '原插件逻辑（vendor/index.js）零移植复用，通过 mcp.json 声明的 stdio MCP 服务器暴露。',
    '使用前确认 SearXNG 实例可达：mcp.json 的 env.SEARXNG_URL（或系统环境变量）。',
    '调用示例：' + toolName + ' 工具，参数 query="DeepSeek Harness"',
    '',
  ].join('\n') + '\n');

  writeFileSafe(path.join(pkgDir, 'CONVERSION-REPORT.md'), [
    `# 转换报告：DSH 搜索提供方插件 → agent-plugins MCP 包`,
    '',
    `- 来源: ${srcFile}`,
    `- 插件名: ${pluginName}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 转换方式: 运行时桥接（vendor + 依赖垫片）`,
    '',
    `## 能力映射`,
    '',
    `- \`ctx.web.registerSearchProvider(...)\` → MCP 工具 \`${toolName}\`（mcp.json 声明，stdio 服务器 mcp-server.js）`,
    `- 依赖 @deepseek-ai/schemastery、dsh-web、dsh-launch-environment → vendor/ 下本地垫片`,
    `- 原搜索逻辑（语言检测 / categories / 归一化）→ 原样复用`,
    '',
    `## 安装`,
    '',
    `1. 复制本目录到 ~/.minimax/plugins/${pluginName}/`,
    `2. MiniMax Code 中 /plugins → Local → 安装并启用`,
    `3. 确认 SearXNG 地址：mcp.json env.SEARXNG_URL 或系统环境变量`,
    '',
    `## 警告`,
    '',
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['（无）']),
    '',
  ].join('\n') + '\n');

  writeFileSafe(path.join(pkgDir, 'README.md'), [
    `# ${pluginName}`,
    '',
    `由 crossplug 从 DSH 插件「${base}」转换（运行时桥接为 MCP 服务器）。`,
    '',
    `- MCP 工具：\`${toolName}\`（stdio，node ./mcp-server.js）`,
    `- 配置：\`mcp.json\` 的 \`env.SEARXNG_URL\`，或系统环境变量`,
    `- 原插件源码：\`vendor/index.js\`（依赖已垫片化）`,
    '',
  ].join('\n') + '\n');

  return {
    kind: 'provider-bridge',
    source: srcFile,
    out: pkgDir,
    packageName: pluginName,
    toolName,
    warnings: warnings.length,
    reportFile: path.join(pkgDir, 'CONVERSION-REPORT.md'),
  };
}

// ═══ 入口 ═══

function convert(src, outDir) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) return convertPreset(src, outDir);
  if (stat.isFile()) {
    const source = fs.readFileSync(src, 'utf8');
    // 搜索提供方插件（ctx.web.registerSearchProvider）：转为 agent-plugins MCP 包
    if (/registerSearchProvider\s*\(/.test(source)) return convertProviderPlugin(src, outDir);
    return convertPluginSource(src, outDir);
  }
  throw new Error(`无法识别的输入: ${src}`);
}

module.exports = { convert, convertPreset, convertPluginSource, convertProviderPlugin };
