// mapping.js — 已知 DSH 插件行 ↔ pi/mcode 能力映射表（零依赖）
//
// 用途：dsh2mcode 把 DSH agent preset 的每一行翻译成 pi extension 里
// 可表达的能力，或标记为"无对应能力"的桩。
//
// kind 取值：
//   builtin  — pi 运行时自带该能力，无需转换（extension 中只写注释）
//   tool     — 生成 pi.registerTool 桩（同名、同描述、空参数）
//   command  — 生成 pi.registerCommand 桩
//   persona  — 生成 /persona 命令与启动通知
//   note     — 只写说明注释（无运行时动作）
//   warn     — 无对应能力，生成带警告的桩

'use strict';

// 已知 @deepseek-ai/dsh-* 插件行的映射
const ROW_MAP = {
  persona: { kind: 'persona', pi: '无直接对应：DSH 的 persona 是系统提示注入，pi 无等价 API；转换后通过 /persona 命令与启动通知保留', note: 'persona 文本会完整写入 extension 注释与 CONVERSION-REPORT.md' },
  'agent-instructions': { kind: 'note', pi: 'agent-instructions 是指令大小限制，无 pi 对应', note: '' },

  // ── shell / 文件 ──
  'tool-bash': { kind: 'builtin', pi: 'pi 自带 bash 工具', note: '' },
  'tool-pwsh': { kind: 'builtin', pi: 'pi 自带 bash 工具；PowerShell 语义需人工核对', note: '' },
  'tool-fs': { kind: 'builtin', pi: 'pi 自带 read/write/edit 文件工具', note: '' },
  'tool-fs-search': { kind: 'builtin', pi: 'pi 自带 grep/glob 搜索能力', note: '' },

  // ── 任务 / 后台 / 目标 ──
  'tool-todo': { kind: 'tool', pi: 'pi 无内建任务清单工具；生成同名桩，逻辑需移植（pi 可用 appendEntry + details 自建持久状态）', note: 'execute 为占位实现' },
  'tool-jobs': { kind: 'warn', pi: 'pi 无后台任务注册表对应', note: '' },
  'tool-goal': { kind: 'warn', pi: 'pi 无 goal 服务对应；会话树与 setLabel 可作轻量替代，持续目标由模型自行跟进', note: '' },

  // ── 网络 ──
  'tool-web': { kind: 'builtin', pi: 'pi 自带网页搜索/抓取能力（如配置了 web 搜索）', note: '' },
  'tool-web-search': { kind: 'builtin', pi: 'pi 自带网页搜索能力', note: '' },

  // ── 交互 ──
  'tool-ask-user': { kind: 'tool', pi: 'pi 用 ctx.ui.confirm/input 表达；生成桩工具并注释对应 ctx.ui 用法', note: '建议改写成 ctx.ui 交互' },

  // ── 委派 / 工作流 ──
  // pi 官方 examples/extensions/ 有 subagent/（registerTool + exec）与 plan-mode/
  // 完整实现——以下能力不是"pi 没有"，而是"pi 用扩展自行实现"。
  'tool-subagent': { kind: 'warn', pi: 'pi 无内建子代理工具；但扩展可自行实现（pi 官方示例 examples/extensions/subagent/：registerTool + exec）', note: '' },
  'tool-subagent-control': { kind: 'warn', pi: '无直接对应；扩展自建子代理时可用 pi.getAllTools() 自省 + setActiveTools 控制', note: '' },
  'tool-subagent-list-agents': { kind: 'warn', pi: '无直接对应；pi.getAllTools() 返回全部工具元数据（含 sourceInfo）可作自省', note: '' },
  'tool-workflow': { kind: 'warn', pi: '无 workflow 引擎内建；可用动态工具加载（setActiveTools 纯增量）模拟按需能力', note: '' },
  'tool-ralph': { kind: 'warn', pi: '无 fresh-agent 循环内建；扩展可自行实现（registerTool + sendUserMessage 接力）', note: '' },

  // ── Cordis 自指 ──
  'tool-cordis': { kind: 'warn', pi: '无对应：pi 没有运行时内省工具', note: '' },

  // ── 规划 / 压缩 / 委派分组（组合概念）──
  planning: { kind: 'note', pi: 'pi 无内建 plan mode；但扩展可实现（pi 官方示例 examples/extensions/plan-mode/：registerCommand + registerShortcut + registerFlag + setActiveTools）', note: '' },
  compaction: { kind: 'note', pi: '上下文压缩由 pi 自带管理（session_before_compact / session_compact 事件可自定义）', note: '' },
  delegation: { kind: 'note', pi: '子代理/工作流无内建，可经扩展实现（见 tool-subagent 一行）', note: '' },

  // ── 命令 ──
  'command-compact': { kind: 'command', pi: '生成 /compact 桩命令', note: 'pi 自带压缩；桩仅提示' },
  'command-plan': { kind: 'command', pi: '生成 /plan 桩命令', note: 'pi 无计划模式；桩仅提示' },

  // ── 技能 ──
  'skill-filesystem': { kind: 'note', pi: '技能已通过 ~/.agents/skills 共享，无需转换', note: '' },
  'tool-skill': { kind: 'note', pi: '技能加载机制双方独立；技能内容走共享目录', note: '' },
};

// 兜底：未知 @deepseek-ai/dsh-* 行
function classifyRow(row) {
  const name = row.name || '';
  const base = name.replace(/^@deepseek-ai\//, '');
  // npm 包名形如 dsh-tool-ask-user；映射表键是 tool-ask-user —— 两种都试
  const short = base.replace(/^dsh-/, '');
  // 组行（cordis:group）与本地文件行：按行 id 匹配（如 planning / compaction / delegation）
  const idShort = String(row.id || '').replace(/^dsh-/, '');
  if (ROW_MAP[base]) return ROW_MAP[base];
  if (ROW_MAP[short]) return ROW_MAP[short];
  if (ROW_MAP[idShort]) return ROW_MAP[idShort];
  if (base.startsWith('dsh-')) {
    return { kind: 'warn', pi: '未知 DSH 插件行，无自动映射；请人工评估', note: '' };
  }
  return { kind: 'warn', pi: '非 @deepseek-ai 插件行（可能是本地文件或第三方包），无自动映射', note: '' };
}

module.exports = { ROW_MAP, classifyRow };
