// SessionStart 钩子 —— 注入「仓库待办账本索引 + 体量状态」。
//
// 与 session-rules.mjs 并列（hooks.json 里的**第二个** SessionStart 条目），刻意分开：
//   - **独立失败域** —— 本文件抛错不影响 context 注入，反之亦然；
//   - SessionStart 的 additionalContext 是**累积**的，两个条目各注入一段，互不覆盖，
//     不需要合并逻辑。
//
// 为什么需要它：技能（skills）是按需调用的**工具**，开场不会自动加载；
// 于是「新会话只说一句继续」时，模型看不到待办账本。而 SessionStart 注入是**确定性**的。
//
// 只读、fail-open、有长度上限 —— 细则见 lib/entrypoints.mjs 顶部注释。

import { readStdinAsync, field, emitContext, emitPass } from "../lib/io.mjs";
import { resolveProject } from "../lib/project.mjs";
import { loadEntrypoints, buildEntrypointBlocks } from "../lib/entrypoints.mjs";

try {
  const payload = await readStdinAsync();

  if (field(payload, "hook_event_name", "hookEventName") !== "SessionStart") emitPass();

  const cwd = field(payload, "cwd") || process.cwd();
  const ctx = resolveProject(cwd);
  if (ctx.isHome) emitPass(); // home 不是项目

  // 零配置也能有东西：没写 entrypoints[] 时 loadEntrypoints 回退到内置约定集
  // （gate = 仓库里有账本载体文件）。真要关掉，写 "entrypoints": []。
  const loaded = loadEntrypoints(ctx.root);
  if (!loaded) emitPass(); // 既没配置、也不符合约定 → 什么都不注入

  const blocks = buildEntrypointBlocks(ctx.root, loaded.specs);
  if (blocks.length === 0) emitPass(); // 无可注入内容 → 不输出空块

  emitContext("SessionStart", blocks.join("\n"));
} catch {
  emitPass(); // fail-open：注入失败绝不阻塞会话
}
