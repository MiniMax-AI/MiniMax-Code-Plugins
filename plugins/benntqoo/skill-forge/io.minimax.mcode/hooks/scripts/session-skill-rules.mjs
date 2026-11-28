// Hook — session-skill-rules.mjs  (SessionStart, matcher: compact|clear)
//
// 作用：会话被压缩或清空之后，把「skill 沉淀三铁律」重新注入一次。
//
// 为什么只匹配 compact|clear 而不匹配 startup：
//   正常启动时，项目根的 AGENTS.md 已被读取；若 AGENTS.md 里没有沉淀规则，
//   规则就靠 skill-forge 技能的 description 语义触发。
//   但 compact（上下文压缩）之后，规则可能已被压掉 —— 这时才需要补刀。
//
// 这是一条保险，不是主渠道。主渠道是 skill-forge 技能。

import { readStdinAsync, field, emitContext, emitPass } from "../lib/io.mjs";
import { resolveSkillTarget } from "../lib/project.mjs";

const payload = await readStdinAsync();
const eventName = field(payload, "hook_event_name", "hookEventName");

if (eventName !== "SessionStart") {
  emitPass();
}

// 落点按当前工作区现算 —— 插件全局安装，规则注入时必须指向「本项目」而非全局库。
// isUserLevel（工作区就是 home）时没有项目级落点，退回用户级目录，语义上无歧义。
const target = resolveSkillTarget(field(payload, "cwd"));
const skillDir = target.isUserLevel
  ? "the user-level skills directory"
  : target.skillsDir.replace(/\\/g, "/");

emitContext(
  "SessionStart",
  [
    "[skill-forge] Context was compacted — reloading the skill-distillation rules:",
    "",
    "1. Distill when you are done — if this turn took 5+ exploratory steps, worked around a",
    "   non-obvious pitfall, or settled on a convention that will be reused, write it before",
    "   you finish: `" + skillDir + "/<kebab-name>/SKILL.md` (this project only — never the",
    "   user-level global library). Do not ask whether to save it.",
    "   The frontmatter needs at least name / description; the description must state WHEN to",
    "   use it, with the trigger conditions first.",
    "",
    "2. Re-read what you used — if this turn called any skill, read it once more before you",
    "   finish and fix outdated commands, wrong tool names, or missing steps in the same turn.",
    "",
    "3. Fix what you find wrong — while reading any SKILL.md, correct typos and dead paths on",
    "   the spot instead of only reporting them.",
    "",
    "Not worth distilling: one-off questions, pure lookups, no new method. Do not write filler.",
    "Every skill costs budget in the per-turn skill list; too many and automatic triggering drops.",
  ].join("\n")
);
