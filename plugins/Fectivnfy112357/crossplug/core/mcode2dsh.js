// mcode2dsh.js — mcode（MiniMax Code / pi extension）→ DSH agent preset（零依赖）
//
// 输入：
//   1. pi extension 文件（.js / .ts）
//   2. mcode 插件包目录（package.json 的 main / index.js / extension.js）
//
// 输出：一个自包含的 DSH agent preset：
//   preset.yml                 — 元数据
//   agent.cordis.yml           — persona 行 + 桥接插件行（name: ./plugins/bridge.js）
//   plugins/bridge.js          — 运行时桥接：用 pi-API 垫片调用原 extension 的工厂，
//                                registerTool → ctx.tools.register，registerCommand → ctx.commands.register
//   vendor/                    — 原 extension（TS 已剥离类型；typebox 导入重写为本地垫片）
//   CONVERSION-REPORT.md       — 提取到的工具/命令清单与警告
//
// 桥接方案让原插件的 execute/命令逻辑原样运行，无需转译逻辑本身。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { findCalls } = require('./extract.js');
const { INLINE_BRIDGE_HELPERS, typeboxShimCode } = require('./schema.js');

const EXT_NAMES = ['index.js', 'extension.js', 'main.js', 'index.ts', 'extension.ts', 'main.ts'];

// ── 定位 extension 文件 ──

function locateExtension(dir) {
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) {
        const main = path.resolve(dir, pkg.main);
        if (fs.existsSync(main)) return { file: main, pkg };
      }
      // pi 包格式：package.json 的 "pi": { "extensions": ["./src/index.ts"] } 声明扩展入口
      // （见 pi 官方 docs/extensions.md "Package with dependencies"）
      if (pkg.pi && Array.isArray(pkg.pi.extensions)) {
        for (const entry of pkg.pi.extensions) {
          if (typeof entry !== 'string') continue;
          const f = path.resolve(dir, entry);
          if (fs.existsSync(f)) return { file: f, pkg };
        }
      }
    } catch { /* 忽略坏 package.json */ }
  }
  for (const name of EXT_NAMES) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return { file: f, pkg: undefined };
  }
  return undefined;
}

// ── TS 类型剥离（保守版）──

function stripTypes(source) {
  let out = source;
  // 1) 整行类型导入/导出
  out = out.replace(/^\s*import\s+type\b[^\n]*$/gm, '');
  out = out.replace(/^\s*export\s+type\b[^\n]*$/gm, '');
  // 2) interface / type 声明（单行或多行到匹配的 '}'）—— 用括号配对处理多行
  out = out.replace(/^\s*(export\s+)?interface\s+\w+[^{]*\{[\s\S]*?\n\}/gm, '');
  out = out.replace(/^\s*(export\s+)?type\s+\w+\s*=[^;]*;/gm, '');
  // 3) 常见类型标注 `: Type` / `: string` 等
  out = out.replace(/:\s*(Type\.\w+|string|number|boolean|unknown|any|void|never|object|Array<[^>]*>|Promise<[^>]*>|Record<string,[^>]*>|ExtensionAPI|ExtensionContext|ExtensionCommandContext|JsonValue|StringEnum<[^>]*>)\b/g, '');
  // 4) `as X` 断言（保留 const 等 enum 场景？as const 也要去）
  out = out.replace(/\s+as\s+(const|Type|string|number|boolean|unknown|any|never|JsonValue|ExtensionAPI|ExtensionContext)\b/g, '');
  // 5) 泛型实参 <...>（保守：只处理紧随标识符且内容是类型词汇的）
  out = out.replace(/([A-Za-z_$][\w$]*)\s*<([A-Za-z_$][\w$]*|Type\.\w+|string|number|boolean|unknown|any|void)(\s*,\s*[^>]+)?>\s*(?=[(=;{])/g, '$1');
  return out;
}

function checkSyntax(file) {
  // 进程内语法校验（等价 node --check 的 CJS 语义，但不 spawn 子进程）
  try {
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: file });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message ? err.message : String(err)).trim() };
  }
}

// ── typebox 导入重写 ──

function rewriteVendorSource(source, baseName, warnings) {
  let out = source;
  // 1) 去掉 pi 包的 import type 行
  out = out.replace(/^\s*import\s+type[^\n]*from\s+["']@earendil-works[^\n]*$/gm, '');
  out = out.replace(/^\s*import[^\n]*from\s+["']@earendil-works\/pi-(?:coding-agent|ai|tui|agent-core)[^\n]*$/gm, (m) => {
    warnings.push('移除了 pi 包的运行时导入（桥接环境不提供）：' + m.trim().slice(0, 80));
    return '';
  });
  // 2) typebox 导入 → 本地垫片
  out = out.replace(/from\s+["']typebox["']/g, 'from "./typebox-shim.js"');
  if (/from\s+["']typebox["']/.test(source)) warnings.push('typebox 导入已重写为本地垫片 vendor/typebox-shim.js');
  // 3) vendor 相对导入修正：extension 平铺进输出 vendor/ 后，原 "./vendor/X"（相对
  //    源包目录）会解析成 vendor/vendor/X —— 重写为 "./X"（X 已随 vendor/ 一起复制）。
  out = out.replace(/from\s+["']\.\/vendor\/([^"']+)["']/g, 'from "./$1"');
  if (/from\s+["']\.\/vendor\//.test(source)) warnings.push('源包的 ./vendor/ 相对导入已修正为平铺路径');
  return out;
}

// ── 生成 ──

function convert(extensionFile, outDir, opts = {}) {
  const isHost = !!opts.host; // host 模式：输出宿主组合插件（lib/index.js），而非 agent preset
  const src = path.resolve(extensionFile);
  const ext = path.extname(src);
  const isTs = ext === '.ts';
  const source = fs.readFileSync(src, 'utf8');
  const warnings = [];

  // 包元数据（若输入是包目录）
  let pkgMeta = undefined;
  const srcDir = path.dirname(src);
  const pkgPath = path.join(srcDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try { pkgMeta = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* 忽略 */ }
  }

  // 提取注册信息（用于报告；运行时由桥接器兜底）
  const tools = [];
  const commands = [];
  const events = [];
  for (const call of findCalls(source, /(?:pi\.)?registerTool/g)) {
    const m = /name:\s*["']([^"']+)["']/.exec(call.argsText);
    if (m) tools.push(m[1]);
  }
  for (const call of findCalls(source, /(?:pi\.)?registerCommand/g)) {
    const m = /^\s*["']([^"']+)["']/.exec(call.argsText);
    if (m) commands.push(m[1]);
  }
  for (const call of findCalls(source, /(?:pi\.)?on/g)) {
    const m = /^\s*["']([^"']+)["']/.exec(call.argsText);
    if (m) events.push(m[1]);
  }

  // 名称与描述：目录输入（包）时用目录名作 base，单文件输入用文件名
  const base = opts.dirName || path.basename(src, ext);
  const presetId = slugify(pkgMeta ? (pkgMeta.name || base) : base) || 'from-mcode';
  const presetName = pkgMeta ? pkgMeta.name : base;
  const presetDesc = pkgMeta && pkgMeta.description ? pkgMeta.description : `由 mcode/pi extension「${base}」转换生成的 DSH agent preset（桥接模式）`;

  // ── vendor 文件准备 ──
  const vendorDir = path.join(outDir, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  let vendorFileName = path.basename(src);
  let vendorSource = source;
  if (isTs) {
    // 生成剥离类型后的 .js
    const stripped = stripTypes(source);
    vendorFileName = path.basename(src, '.ts') + '.js';
    fs.writeFileSync(path.join(vendorDir, vendorFileName), stripped, 'utf8');
    fs.copyFileSync(src, path.join(vendorDir, path.basename(src))); // 保留原 .ts
    const chk = checkSyntax(path.join(vendorDir, vendorFileName));
    if (!chk.ok) {
      warnings.push('TS 类型剥离后语法校验失败：' + chk.error.slice(0, 300) + ' —— 请手工把 extension 编译为 JS 后再转换');
    }
    warnings.push('TS 源文件已做保守类型剥离（vendor/' + vendorFileName + '），请人工核对');
  } else {
    fs.writeFileSync(path.join(vendorDir, vendorFileName), vendorSource, 'utf8');
  }
  // 重写：typebox → 本地垫片；pi 运行时导入 → 注释
  const rewritten = rewriteVendorSource(vendorSource, vendorFileName, warnings);
  fs.writeFileSync(path.join(vendorDir, vendorFileName), rewritten, 'utf8');
  if (rewritten.includes('from "./typebox-shim.js"')) {
    fs.writeFileSync(path.join(vendorDir, 'typebox-shim.js'), typeboxShimCode(), 'utf8');
  }
  // 复制源包同目录的辅助文件，让带相对导入的 extension 包（如 crossplug dsh2mcode 产物：
  // vendor/dsh-plugin.js + typebox-shim.js）转换后自包含。
  // 不覆盖已生成的 vendorFileName（源 vendor/ 里若有同名文件以转换产物为准）。
  const srcVendorDir = path.join(srcDir, 'vendor');
  if (fs.existsSync(srcVendorDir)) {
    fs.mkdirSync(vendorDir, { recursive: true });
    for (const entry of fs.readdirSync(srcVendorDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && entry.name === vendorFileName) continue;
      const s = path.join(srcVendorDir, entry.name);
      const d = path.join(vendorDir, entry.name);
      if (entry.isDirectory()) copyDir(s, d);
      else if (entry.isFile()) fs.copyFileSync(s, d);
    }
    warnings.push('源包 vendor/ 依赖已复制到输出 vendor/（' + fs.readdirSync(srcVendorDir).filter((n) => n !== vendorFileName).join('、') + '）');
  }
  for (const aux of ['typebox-shim.js', 'typebox-shim.mjs']) {
    const p = path.join(srcDir, aux);
    if (fs.existsSync(p) && !fs.existsSync(path.join(vendorDir, aux))) {
      fs.copyFileSync(p, path.join(vendorDir, aux));
      warnings.push('源包辅助文件 ' + aux + ' 已复制到输出 vendor/');
    }
  }
  // 包内 skills 目录
  const srcSkills = path.join(srcDir, 'skills');
  const hasSkills = fs.existsSync(srcSkills);

  // ── 生成 agent.cordis.yml（仅 preset 模式）──
  if (!isHost) {
    const personaText = [
      `你是由 mcode/pi extension「${presetName}」转换而来的 DSH agent。`,
      `转换模式：运行时桥接 —— 原 extension 的工厂函数在本会话进程中执行，`,
      `其 registerTool / registerCommand 注册的能力已映射为 DSH 工具与命令。`,
      presetDesc,
    ].join('\n');
    const compositionRows = [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', configText: personaText },
      { id: 'converted-plugin', name: './plugins/bridge.js' },
    ];
    const { renderPresetYaml, renderCompositionYaml } = require('./yaml.js');
    fs.writeFileSync(path.join(outDir, 'preset.yml'), renderPresetYaml({ name: presetName, description: presetDesc, order: 90 }), 'utf8');
    fs.writeFileSync(
      path.join(outDir, 'agent.cordis.yml'),
      renderCompositionYaml(compositionRows, [
        '由 crossplug (core/mcode2dsh.js) 生成 —— 桥接自 pi extension ' + path.basename(src),
        '桥接插件（plugins/bridge.js）在本 preset 目录内自包含，零 npm 依赖。',
        '原 extension 与剥离/重写后的副本在 vendor/。',
      ]),
      'utf8',
    );
  }
    // ── 生成 lib/index.js（宿主组合插件形态：所有会话可用，不依赖 preset 选择）──
  const bridge = renderBridge(presetId, vendorFileName, tools, commands, events, warnings, isHost);
  if (isHost) {
    fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'lib', 'index.js'), bridge, 'utf8');
    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({
      name: presetId,
      version: '0.1.0',
      description: `由 mcode/pi extension「${presetName}」转换生成的 DSH 宿主组合插件（crossplug 桥接）`,
      type: 'module',
      main: 'lib/index.js',
    }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(outDir, 'README.md'), [
      '# ' + presetId,
      '',
      '由 crossplug (core/mcode2dsh.js) 从 mcode/pi extension「' + presetName + '」转换生成的宿主组合插件。',
      '所有会话可用，不依赖 agent preset。安装：',
      '  1. 复制本目录到 ~/.dsh/profiles/<mode>/plugins/' + presetId + '/',
      '  2. 在 profile 的 cordis.patch.yml 追加：',
      '     - insert:',
      '         - id: ' + presetId,
      "           name: './plugins/" + presetId + "/lib/index.js'",
      '  3. 重启 DSH 进程。',
      '',
    ].join('\n') + '\n', 'utf8');
  } else {
    fs.mkdirSync(path.join(outDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'plugins', 'bridge.js'), bridge, 'utf8');
  }
    // ── 报告 ──
  const report = [
    `# 转换报告：mcode/pi extension → DSH ${isHost ? '宿主组合插件（host plugin）' : 'agent preset'}`,
    '',
    `- 来源: ${src}`,
    `- 插件 id（建议目录名）: ${presetId}`,
    `- 生成时间: ${new Date().toISOString()}`,
    '',
    `## 识别到的注册`,
    '',
    `- 工具（${tools.length}）: ${tools.map((t) => '`' + t + '`').join('、') || '（未识别到）'}`,
    `- 命令（${commands.length}）: ${commands.map((c) => '/' + c).join('、') || '（未识别到）'}`,
    `- 事件（${events.length}）: ${events.map((e) => '`' + e + '`').join('、') || '（未识别到）'}`,
    '',
    `## 警告`,
    '',
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['（无）']),
    '',
    `## 说明`,
    '',
    `- 运行时桥接器会把 pi 的 registerTool 映射为 DSH 工具注册（参数 schema 自动转换，输出为宽松 JSON）。`,
    `- registerCommand 映射为 DSH 斜杠命令（handler 包装为 CommandResult）。`,
    `- 事件桥接：before_agent_start → system-prompt/assemble（1:1）；turn_end / turn_start / tool_call / tool_result / message_start / message_end → session/event 子事件（弱/只读转发；pi 的 block/结果改写能力不生效，详见 doc/event-mapping-questions.md）。`,
    `- 工具 execute 中引用的 pi 运行时 API（如 ctx.ui）由垫片提供最小实现，复杂交互需人工适配。`,
    '',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'CONVERSION-REPORT.md'), report, 'utf8');

  return {
    kind: isHost ? 'mcode-extension-host' : 'mcode-extension',
    source: src,
    out: outDir,
    presetId,
    presetName,
    tools: tools.length,
    commands: commands.length,
    events: events.length,
    warnings: warnings.length,
    reportFile: path.join(outDir, 'CONVERSION-REPORT.md'),
  };
}

function renderBridge(presetId, vendorFileName, tools, commands, events, warnings, isHost) {
  const toolList = JSON.stringify(tools, null, 2);
  const commandList = JSON.stringify(commands, null, 2);
  const eventList = JSON.stringify(events, null, 2);
  return `// 由 crossplug (core/mcode2dsh.js) 生成的运行时桥接插件。
// 零 npm 依赖：只用 DSH 的 ctx 服务（tools / commands）与 node 内置能力。
// 它加载 vendor/${vendorFileName}（原 pi extension），用 pi-API 垫片调用其默认导出工厂，
// 把 registerTool / registerCommand 映射为 DSH 注册。

${INLINE_BRIDGE_HELPERS}
function piShim(ctx, log) {
  const tools = ctx.get('tools');
  const commands = ctx.get('commands');
  const registered = [];
  const warned = new Set();
  const warnOnce = (what) => {
    if (warned.has(what)) return;
    warned.add(what);
    log('[bridge] ' + what);
  };
  const shimCtx = {
    ui: {
      notify: (msg) => log('[bridge:ui.notify] ' + String(msg)),
      setStatus: (key, text) => log('[bridge:ui.status] ' + key + ' = ' + text),
      setWidget: (key, lines) => log('[bridge:ui.widget] ' + key),
      confirm: async () => true,
      input: async (question) => { log('[bridge:ui.input] ' + question); return ''; },
      select: async () => null,
      custom: () => { warnOnce('ctx.ui.custom 无 DSH 对应，已空操作'); return { render() {} }; },
    },
    session: {},
    // 逆向事件桥接的 pi handler 收集桶（on() 对可桥接事件写入）
    _piListeners: {},
  };

  const api = {
    registerTool(t) {
      if (!t || typeof t.name !== 'string') { warnOnce('registerTool 缺少 name，跳过'); return; }
      if (!tools) { warnOnce('DSH tools 服务不可用，工具 ' + t.name + ' 未注册'); return; }
      try {
        const schema = tbToJsonSchema(t.parameters);
        tools.register({
          name: t.name,
          description: t.description || '',
          parameters: schema,
          output: {
            schema: {},
            render(_args, value) {
              let text = '';
              if (value && typeof value === 'object' && Array.isArray(value.content)) {
                text = value.content.map((c) => (c && typeof c.text === 'string' ? c.text : JSON.stringify(c))).join('\\n');
              } else {
                text = JSON.stringify(value, null, 2);
              }
              return [{ type: 'text', text }];
            },
          },
          async execute(args, exec) {
            if (typeof t.execute !== 'function') {
              return { content: [{ type: 'text', text: '[桥接桩] ' + t.name + ' 未提供 execute' }], details: {} };
            }
            try {
              const r = await t.execute(exec.callId, args, exec.signal, undefined, shimCtx);
              if (r && typeof r === 'object' && Array.isArray(r.content)) return r;
              return r;
            } catch (e) {
              throw new Error('[bridge:' + t.name + '] ' + (e && e.message ? e.message : String(e)));
            }
          },
        });
        registered.push('tool:' + t.name);
      } catch (e) {
        log('[bridge] 工具 ' + t.name + ' 注册失败: ' + e.message);
      }
    },
    registerCommand(name, def) {
      if (!commands || !name) { warnOnce('commands 服务不可用或命令缺名: ' + name); return; }
      try {
        commands.register({
          name,
          description: (def && def.description) || '',
          async handler(invocation) {
            try {
              const r = await def.handler((invocation.rawInput || '').trim(), shimCtx);
              const text = typeof r === 'string' ? r : r === undefined || r === null ? '' : JSON.stringify(r, null, 2);
              return { kind: 'success', text };
            } catch (e) {
              return { kind: 'error', text: '[bridge:' + name + '] ' + (e && e.message ? e.message : String(e)) };
            }
          },
        });
        registered.push('command:' + name);
      } catch (e) {
        log('[bridge] 命令 /' + name + ' 注册失败: ' + e.message);
      }
    },
    registerShortcut: (s) => warnOnce('registerShortcut 无 DSH 对应，已跳过: ' + JSON.stringify(s)),
    registerFlag: (f) => warnOnce('registerFlag 无 DSH 对应，已跳过: ' + JSON.stringify(f)),
    registerProvider: (p) => warnOnce('registerProvider 无 DSH 对应，已跳过: ' + JSON.stringify(p)),
    appendEntry: () => warnOnce('appendEntry 无 DSH 对应，已跳过'),
    on(event, handler) {
      // 可逆向桥接的 pi 事件（对照 mcode-plugin-spec.md §5.2 / §15.3）：
      //   before_agent_start → system-prompt/assemble（1:1）
      //   turn_end → session/event(turn/end)（1:1）
      //   turn_start → session/event(turn/start)（弱）
      //   tool_call → session/event(tool/call)（只读转发；pi 的 block 能力 DSH 侧不存在）
      //   tool_result → session/event(tool/result)（只读转发；pi 的结果改写能力 DSH 侧不存在）
      //   message_start → session/event(user/message)（弱）
      //   message_end → session/event(assistant/message)（弱）
      // 其余事件：跳过并记日志（逻辑保留在 vendor 文件中）。
      const BRIDGE_EVENTS = {
        before_agent_start: 'system-prompt/assemble',
        turn_end: 'session/event',
        turn_start: 'session/event',
        tool_call: 'session/event',
        tool_result: 'session/event',
        message_start: 'session/event',
        message_end: 'session/event',
      };
      if (BRIDGE_EVENTS[event]) {
        const list = shimCtx._piListeners[event] || (shimCtx._piListeners[event] = []);
        list.push(handler);
        return;
      }
      warnOnce('pi 事件 ' + event + ' 无 1:1 DSH 事件，监听已跳过（逻辑保留在 vendor 文件中）');
    },
  };

  return { api, registered, shimCtx };
}

export default {
  // host 模式（宿主组合插件）声明式依赖；preset 模式由组合行内联激活
  inject: ['tools', 'commands'],
  async apply(ctx) {
    const log = (msg) => { try { console.log('[crossplug:' + ${JSON.stringify(presetId)} + ']', msg); } catch { /* 忽略 */ } };
    try {
      const mod = await import('../vendor/${vendorFileName}');
      const factory = mod && (mod.default !== undefined ? mod.default : mod);
      if (typeof factory !== 'function') {
        log('vendor/${vendorFileName} 没有默认导出工厂，无法桥接');
        return;
      }
      const { api, registered, shimCtx } = piShim(ctx, log);
      await factory(api);
      log('桥接完成，注册了: ' + (registered.length ? registered.join(', ') : '（无）'));

      // ── 逆向事件桥接：pi 事件 → DSH 事件 ──
      // 1:1：before_agent_start → system-prompt/assemble（DSH host 平面每会话首轮组装，
      //   handler(assembly, context, next)，assembly.sections.push({ name, text }) 注入段落）。
      // 弱/只读：turn_end / turn_start / tool_call / tool_result / message_start / message_end
      //   → session/event（DSH handler(session, event) 按 event.type 过滤，payload 在 event.data；
      //   KNOWN_SESSION_EVENT_TYPES：turn/end、turn/start、tool/call、tool/result、
      //   user/message、assistant/message）。pi 的 block（tool_call）与结果改写（tool_result）
      //   能力在 DSH 侧不存在——只读转发，返回值忽略。
      // 仅当 ctx 提供 on()（宿主组合/测试 mock 可能没有）且收集到 handler 时注册。
      const piListeners = shimCtx._piListeners || {};
      if (ctx && typeof ctx.on === 'function') {
        if (piListeners['before_agent_start'] && piListeners['before_agent_start'].length) {
          try {
            ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
              for (const handler of piListeners['before_agent_start']) {
                try {
                  const r = await handler({ systemPrompt: '' }, shimCtx);
                  if (r && typeof r.systemPrompt === 'string' && r.systemPrompt.length) {
                    assembly.sections.push({ name: 'mcode-bridge:' + ${JSON.stringify(presetId)}, text: r.systemPrompt });
                  }
                } catch (e) {
                  log('before_agent_start handler 抛错: ' + (e && e.message ? e.message : String(e)));
                }
              }
              // DSH 的 system-prompt/assemble 是链式监听（原 dsh-hindsight-client 实证）：
              // 必须调用 next() 继续链，否则宿主组合的组装链中断
              return next();
            });
            log('事件桥接: before_agent_start → system-prompt/assemble');
          } catch (e) {
            log('system-prompt/assemble 桥接注册失败: ' + (e && e.message ? e.message : String(e)));
          }
        }
        const hasSessionEvent = ['turn_end', 'turn_start', 'tool_call', 'tool_result', 'message_start', 'message_end']
          .some((k) => piListeners[k] && piListeners[k].length);
        if (hasSessionEvent) {
          try {
            ctx.on('session/event', async (session, event) => {
              const type = event && event.type;
              const data = event && event.data !== undefined ? event.data : event;
              const fire = async (key, ev) => {
                for (const handler of (piListeners[key] || [])) {
                  try { await handler(ev, shimCtx); }
                  catch (e) { log(key + ' handler 抛错: ' + (e && e.message ? e.message : String(e))); }
                }
              };
              if (type === 'turn/end') {
                // Q2：pi turn_end.message 是 AgentMessage；DSH 侧 session.deriveMessages() 提供消息数组，
                // 尽力桥接（vendor 的 auto-retain 等依赖消息文本的逻辑可工作）
                let msgs = [];
                try {
                  const dm = session && typeof session.deriveMessages === 'function' ? session.deriveMessages() : null;
                  if (Array.isArray(dm)) msgs = dm;
                } catch { /* 忽略 */ }
                await fire('turn_end', { turnIndex: data.turn !== undefined ? data.turn : 0, toolResults: [], message: msgs.length ? msgs : undefined });
              } else if (type === 'turn/start') {
                await fire('turn_start', { turnIndex: data.turn !== undefined ? data.turn : 0 });
              } else if (type === 'tool/call') {
                // pi ToolCallEvent：{ type, toolCallId, toolName, input }（Q3 已确认）
                // DSH arguments 是模型原始 JSON 字符串 → 解析后赋给 input
                let input = data.arguments;
                if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* 保留原文 */ } }
                await fire('tool_call', { type: 'tool_call', toolCallId: data.callId, toolName: data.name, input });
              } else if (type === 'tool/result') {
                // pi ToolResultEvent：{ type, toolCallId, toolName, input, content, details?, isError, usage? }（Q4 已确认）
                // DSH tool/result payload 无 callId/name（{turn, step, message, error?, meta?}）——
                // 从 message（ToolResultMessage，含 callId?/name?/content/details/isError）回溯（Q4 补充答复确认方向正确）
                const msg = data.message || {};
                await fire('tool_result', {
                  type: 'tool_result',
                  toolCallId: msg.callId,
                  toolName: msg.name,
                  input: {},
                  content: msg.content,
                  details: msg.details,
                  isError: msg.isError,
                  usage: msg.usage,
                });
              } else if (type === 'user/message') {
                // pi MessageStartEvent：{ type, message: AgentMessage }（Q5 已确认）；
                // DSH user/message 本身即用户消息，天然对应 pi 的 user 角色
                await fire('message_start', { type: 'message_start', message: data });
              } else if (type === 'assistant/message') {
                await fire('message_end', { type: 'message_end', message: data.message });
              }
            });
            log('事件桥接: session/event ← turn_end/turn_start/tool_call/tool_result/message_start/message_end');
          } catch (e) {
            log('session/event 桥接注册失败: ' + (e && e.message ? e.message : String(e)));
          }
        }
      }
    } catch (e) {
      log('桥接失败: ' + (e && e.message ? e.stack || e.message : String(e)));
    }
  },
};

// ── 生成期提取的注册清单（仅报告参考）──
// tools: ${toolList.replace(/\n/g, '\n// ')}
// commands: ${commandList.replace(/\n/g, '\n// ')}
// events: ${eventList.replace(/\n/g, '\n// ')}
`;
}

function slugify(id) {
  return String(id || 'plugin')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// ═══ 模式二：MCode 插件包（agent-plugins / MiniMax / Claude 兼容 manifest）→ DSH preset ═══

const PLUGIN_MANIFESTS = [
  { file: 'plugin.json', kind: 'AGENT_PLUGINS_V1' },
  { file: path.join('.minimax-plugin', 'plugin.json'), kind: 'MINIMAX' },
  { file: path.join('.claude-plugin', 'plugin.json'), kind: 'CLAUDE_CODE' },
];

function hasPluginManifest(dir) {
  return PLUGIN_MANIFESTS.some((m) => fs.existsSync(path.join(dir, m.file)));
}

function convertPluginPackage(srcDir, outDir) {
  const entry = PLUGIN_MANIFESTS.find((m) => fs.existsSync(path.join(srcDir, m.file)));
  if (!entry) throw new Error('目录中没有插件 manifest（plugin.json / .minimax-plugin/plugin.json / .claude-plugin/plugin.json）');
  const manifestPath = path.join(srcDir, entry.file);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`插件 manifest 解析失败: ${manifestPath}（${e.message}）`);
  }
  const name = manifest.name || path.basename(srcDir);
  const description = manifest.description || `由 mcode 插件「${name}」转换生成的 DSH agent preset`;
  const presetId = slugify(name) || 'from-mcode-plugin';
  const warnings = [];

  // skills/ 目录复制（名字规范化）
  const srcSkills = path.join(srcDir, 'skills');
  const hasSkills = fs.existsSync(srcSkills);
  if (hasSkills) {
    fs.mkdirSync(path.join(outDir, 'skills'), { recursive: true });
    for (const child of fs.readdirSync(srcSkills, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const safe = slugify(child.name) || 'skill';
      copyDir(path.join(srcSkills, child.name), path.join(outDir, 'skills', safe));
      if (safe !== child.name) warnings.push(`skill 目录「${child.name}」重命名为 ${safe}`);
    }
  }

  // mcp.json 读取（仅报告，DSH 侧 MCP 需另行配置）
  const mcpPath = path.join(srcDir, 'mcp.json');
  const mcpNames = [];
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      mcpNames.push(...Object.keys(mcp.mcpServers || {}));
    } catch { /* 忽略坏 mcp.json */ }
  }
  const claudeMcp = path.join(srcDir, '.mcp.json');
  if (fs.existsSync(claudeMcp)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(claudeMcp, 'utf8'));
      mcpNames.push(...Object.keys(mcp.mcpServers || {}));
    } catch { /* 忽略 */ }
  }

  // 生成 preset
  const personaText = [
    `你是由 mcode 插件「${name}」转换而来的 DSH agent（manifest: ${entry.kind}）。`,
    `插件携带的 skills 已挂载到本 preset（skills/ 目录）。`,
    description,
  ].join('\n');

  const compositionRows = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', configText: personaText },
  ];
  if (hasSkills) {
    compositionRows.push({
      id: 'skill-filesystem',
      name: '@deepseek-ai/dsh-skill-filesystem',
      configScalarList: {
        key: 'customSkillDirs',
        items: ['!!js "process.getBuiltinModule(\'node:url\').fileURLToPath(new URL(\'skills/\', baseUrl))"'],
      },
    });
  }
  const { renderPresetYaml, renderCompositionYaml } = require('./yaml.js');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'preset.yml'), renderPresetYaml({ name, description, order: 90 }), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'agent.cordis.yml'),
    renderCompositionYaml(compositionRows, [
      `由 crossplug (core/mcode2dsh.js) 生成 —— 转换自 mcode 插件包 ${path.basename(srcDir)}（manifest: ${entry.kind}）`,
      '插件 skills 已复制到本 preset 的 skills/，由 dsh-skill-filesystem 挂载。',
      '插件中的 MCP 服务器不随 preset 迁移，需在 DSH 侧另行配置（见 CONVERSION-REPORT.md）。',
    ]),
    'utf8',
  );

  // 报告
  const report = [
    `# 转换报告：mcode 插件包 → DSH agent preset`,
    '',
    `- 来源: ${srcDir}`,
    `- manifest: ${manifestPath}（${entry.kind}）`,
    `- 插件名: ${name}`,
    `- preset id（建议目录名）: ${presetId}`,
    `- 生成时间: ${new Date().toISOString()}`,
    '',
    `## 能力映射`,
    '',
    `- skills（${hasSkills ? '已复制到 preset skills/' : '无'}）`,
    `- MCP 服务器（${mcpNames.length ? mcpNames.join('、') : '无'}）：DSH 侧不支持从插件包自动迁移 MCP，需在 DSH 配置中手工添加。`,
    `- apps / extensions 字段：不在转换范围内。`,
    '',
    `## 警告`,
    '',
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ['（无）']),
    '',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'CONVERSION-REPORT.md'), report, 'utf8');

  return {
    kind: 'mcode-plugin-package',
    source: srcDir,
    out: outDir,
    presetId,
    presetName: name,
    manifestKind: entry.kind,
    skills: hasSkills,
    mcpServers: mcpNames,
    warnings: warnings.length,
    reportFile: path.join(outDir, 'CONVERSION-REPORT.md'),
  };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const child of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, child.name);
    const d = path.join(dst, child.name);
    if (child.isDirectory()) copyDir(s, d);
    else if (child.isFile()) fs.copyFileSync(s, d);
  }
}

// ═══ 入口 ═══

function convertInput(src, outDir, opts = {}) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (hasPluginManifest(src)) return convertPluginPackage(src, outDir);
    const found = locateExtension(src);
    if (!found) throw new Error(`目录中没有找到 extension 文件（index.js/extension.js/main.js/index.ts 等）: ${src}`);
    return convert(found.file, outDir, { pkg: found.pkg, dirName: path.basename(src), host: !!opts.host });
  }
  if (stat.isFile()) return convert(src, outDir, { host: !!opts.host });
  throw new Error(`无法识别的输入: ${src}`);
}

module.exports = { convert: convertInput, locateExtension, stripTypes, convertPluginPackage, hasPluginManifest };
