/**
 * editQueue 单测 —— 直接 import 真实实现，不是抄一份。
 *
 * 负向对照设计（对应实测 bug）：
 *   用例 A 复刻修复前的并发写法（hint 不 await + final await），
 *         断言"最终结果必须是消息里最后落盘的内容" → 必然失败
 *   用例 B 用真实 editQueue 做同样的事 → 必须通过
 * 如果哪天有人把 editQueue 改回并发，这个 A/B 对照会立刻翻脸。
 */
process.env.MCODE_FEISHU_BRIDGE_TEST = "1";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const { editQueue, sent, deliverFinal, backoffMs, shouldGiveUp, recordOutcome,
        acquireLock, releaseLock, isPidAlive, killTree, mcodeRun, selectFresh, resolveMcodeCli,
        reportFetchProblem, collectFresh, PAGE_SIZE,
        MCODE_TIMEOUT_MS, MAX_DELIVERY_ATTEMPTS, RETRY_BASE_MS } =
  await import("./mcode-feishu-bridge.mjs");

let pass = 0, fail = 0, skipped = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; results.push(`  ok   ${name}`); }
  else { fail++; results.push(`  FAIL ${name}${detail ? "  <- " + detail : ""}`); }
}
/** 宿主缺少前置条件时跳过，而不是失败——CI 上本来就没有 mcode。 */
function skip(name) { skipped++; results.push(`  skip ${name}`); }

/**
 * 假飞书：内容 = 最后落盘的那次写入。
 * @param durations 每次写入的耗时（ms），用来制造乱序
 */
function fakeFeishu(durations) {
  let n = 0;
  const state = { content: null, order: [] };
  const timers = [];
  const edit = (messageId, text) => new Promise((res) => {
    const d = durations[n++] ?? 10;
    timers.push(setTimeout(() => {
      state.content = text;               // 后写覆盖
      state.order.push(text);
      res({ code: 0, text: JSON.stringify({ ok: true }), ok: true });
    }, d));
  });
  return { edit, state, clear: () => timers.forEach(clearTimeout) };
}

const HINT = "⚙️ 正在调用 `read`…";
const FINAL = "✅ demo2.txt = final test\n\n---\n⏱ 12.3s · 1335 tokens · 2 次工具调用";

// ── A. 负向对照：修复前的并发写法，hint 比 final 慢 → final 必然被盖掉 ──
{
  const { edit, state, clear } = fakeFeishu([80, 10]);  // hint 80ms，final 10ms
  const flying = edit("m1", HINT).catch(() => {});     // 不 await（= 旧代码）
  await edit("m1", FINAL);                              // await（= 旧代码）
  await flying;
  clear();
  check("A 旧并发写法：final 确实会被慢 hint 盖掉（负向对照成立）",
    state.content === HINT,
    `期望 content===HINT，实际 content=${JSON.stringify(state.content)}`);
}

// ── B. 真实 editQueue：同样"慢 hint + 快 final"，final 必须赢 ──
{
  const { edit, state, clear } = fakeFeishu([80, 10]);
  const q = editQueue(edit);
  q.pushHint("m1", HINT);
  q.seal();
  q.push("m1", FINAL);
  await q.drain();
  clear();
  check("B 串行队列：慢 hint 也排在 final 之前，final 赢",
    state.content === FINAL,
    `实际 content=${JSON.stringify(state.content)}`);
  check("B 顺序：hint 先落盘、final 后落盘",
    JSON.stringify(state.order) === JSON.stringify([HINT, FINAL]),
    `order=${JSON.stringify(state.order)}`);
}

// ── C. seal 之后到达的 hint 必须被丢弃 ──
{
  let calls = 0;
  const edit = async (_id, text) => { calls++; return { code: 0, text: JSON.stringify({ ok: true }), content: text }; };
  const q = editQueue(edit);
  q.push("m1", FINAL);
  q.seal();
  q.pushHint("m1", HINT);        // 晚到的 tool 事件
  await q.drain();
  check("C seal 后 hint 被丢弃（只发 1 次）", calls === 1, `calls=${calls}`);
}

// ── D. seal 之前入队的 hint 必须放行（不能把中间状态也吞掉） ──
{
  let calls = 0;
  const edit = async () => { calls++; return { code: 0, text: JSON.stringify({ ok: true }) }; };
  const q = editQueue(edit);
  q.pushHint("m1", HINT);
  q.seal();
  q.push("m1", FINAL);
  await q.drain();
  check("D seal 前入队的 hint 正常执行（共 2 次）", calls === 2, `calls=${calls}`);
}

// ── E. 中途一次编辑抛错，不能卡死队列（失败的在中间，final 仍要落盘） ──
{
  const state = { content: null };
  const timers = [];
  let n = 0;
  const edit = (id, text) => {
    const i = n++;
    if (i === 1) return Promise.reject(new Error("boom"));   // 中间那次失败
    return new Promise((res) => timers.push(setTimeout(() => {
      state.content = text;
      res({ code: 0, text: "{}" });
    }, 5)));
  };
  const q = editQueue(edit);
  q.pushHint("m1", HINT);
  q.pushHint("m1", "⚙️ 正在调用 `write`…");   // 这次会抛错
  q.seal();
  q.push("m1", FINAL);
  await q.drain();
  timers.forEach(clearTimeout);
  check("E 中途抛错不卡死队列，final 仍落盘", state.content === FINAL, `content=${JSON.stringify(state.content)}`);
}

// ── F. sent() 送达判定 ──
check("F exit!=0 → 不算送达", sent({ code: 1, text: "" }) === false);
check("F exit0 + JSON ok:false → 不算送达", sent({ code: 0, text: '{"ok":false}' }) === false);
check("F exit0 + JSON ok:true → 算送达", sent({ code: 0, text: '{"ok":true}' }) === true);
check("F exit0 + 无 JSON → 算送达", sent({ code: 0, text: "plain text" }) === true);
check("F undefined → 不算送达", sent(undefined) === false);

// ── E2. final 自己失败时，drain 返回失败标记（不 throw），让调用方能退回 reply ──
{
  const q = editQueue(() => Promise.reject(new Error("edit failed")));
  q.seal();
  q.push("m1", FINAL);
  const r = await q.drain();
  check("E2 final 失败 → drain 返回失败标记而非 throw",
    r && r.ok === false && r.code === -1, `r=${JSON.stringify(r)}`);
  check("E2 失败标记会被 sent() 判为未送达", sent(r) === false);
}

// ── G. deliverFinal：edit 成功就不该多发一条 reply ──
{
  let edits = 0, replies = 0;
  const q = editQueue(async () => { edits++; return { code: 0, text: '{"ok":true}' }; });
  const reply = async () => { replies++; return { code: 0, text: '{"ok":true}' }; };
  const r = await deliverFinal({ q, phId: "m1", messageId: "u1", finalText: FINAL, reply, log: () => {} });
  check("G edit 成功 → 不发 reply", edits === 1 && replies === 0, `edits=${edits} replies=${replies}`);
  check("G edit 成功 → ok=true", r.ok === true);
}

// ── H. edit 失败 → 必须退回 reply，用户不能卡在占位上 ──
{
  let replies = 0, replied = null;
  const q = editQueue(async () => ({ code: 1, text: "", err: "edit blew up" }));
  const reply = async (mid, text) => { replies++; replied = { mid, text }; return { code: 0, text: '{"ok":true}' }; };
  const r = await deliverFinal({ q, phId: "m1", messageId: "u1", finalText: FINAL, reply, log: () => {} });
  check("H edit 失败 → 退回 reply", replies === 1, `replies=${replies}`);
  check("H 退回的 reply 指向原用户消息且内容完整",
    replied && replied.mid === "u1" && replied.text === FINAL, `replied=${JSON.stringify(replied)}`);
  check("H 兜底成功 → ok=true", r.ok === true);
}

// ── I. edit 与 reply 都失败 → 必须报未送达，让水位不推进 ──
{
  const q = editQueue(async () => ({ code: 1, text: "", err: "edit blew up" }));
  const reply = async () => ({ code: 0, text: '{"ok":false}' });
  const r = await deliverFinal({ q, phId: "m1", messageId: "u1", finalText: FINAL, reply, log: () => {} });
  check("I 两处都失败 → ok=false（水位不推进，下轮重试）", r.ok === false);
}

// ── J. 没有占位消息（发送占位就失败）→ 直接 reply，不做无谓的 edit ──
{
  let edits = 0, replies = 0;
  const reply = async () => { replies++; return { code: 0, text: '{"ok":true}' }; };
  const r = await deliverFinal({ q: null, phId: null, messageId: "u1", finalText: FINAL, reply, log: () => {} });
  check("J 无占位 → 直接 reply 一次", replies === 1 && edits === 0, `replies=${replies} edits=${edits}`);
  check("J 无占位 → ok=true", r.ok === true);
}

// ── K. deliverFinal 必须把队列封住：它返回后再来的 hint 不能改写最终结果 ──
{
  const written = [];
  const q = editQueue(async (_id, text) => { written.push(text); return { code: 0, text: '{"ok":true}' }; });
  await deliverFinal({ q, phId: "m1", messageId: "u1", finalText: FINAL, reply: async () => ({ code: 0, text: "{}" }), log: () => {} });
  q.pushHint("m1", HINT);           // mcode 已收工后才到的 tool 事件
  await q.drain();
  check("K deliverFinal 后队列已封，晚到 hint 不改写结果",
    written.length === 1 && written[0] === FINAL,
    `written=${JSON.stringify(written)}`);
}

// ── L. 退避必须是单调递增的，不能是 0（0 = 立刻重试 = 刷屏） ──
check("L 退避随次数递增", backoffMs(1) < backoffMs(2) && backoffMs(2) < backoffMs(3),
  `b1=${backoffMs(1)} b2=${backoffMs(2)} b3=${backoffMs(3)}`);
check("L 退避永不为 0（否则等于无限立即重试）",
  [1, 2, 3, 10, 999].every(n => backoffMs(n) > 0));
check("L 退避下限是 RETRY_BASE_MS", backoffMs(1) === RETRY_BASE_MS, `b1=${backoffMs(1)}`);
check("L attempts=0 也不会退化成 0", backoffMs(0) === RETRY_BASE_MS, `b0=${backoffMs(0)}`);

// ── M. 必须有放弃上限：这是"无限重试刷屏"的唯一防线 ──
check("M 上限存在且有限", Number.isFinite(MAX_DELIVERY_ATTEMPTS) && MAX_DELIVERY_ATTEMPTS > 0 && MAX_DELIVERY_ATTEMPTS <= 20,
  `max=${MAX_DELIVERY_ATTEMPTS}`);
check("M 到上限必须放弃", shouldGiveUp(MAX_DELIVERY_ATTEMPTS) === true);
check("M 超过上限也放弃", shouldGiveUp(MAX_DELIVERY_ATTEMPTS + 1) === true && shouldGiveUp(999) === true);
check("M 上限之前不能放弃",
  ![1, 2, MAX_DELIVERY_ATTEMPTS - 1].some(n => shouldGiveUp(n)),
  `max=${MAX_DELIVERY_ATTEMPTS}`);

// ── N. recordOutcome：水位必须无条件推进，否则会刷屏死循环 ──
{
  const b1 = { lastMessageId: "old", turns: 3, pending: null };
  recordOutcome(b1, { messageId: "u1", ok: true, phId: "p1", finalText: "F" });
  check("N 送达成功 → 水位推进、pending 清空",
    b1.lastMessageId === "u1" && b1.pending === null, JSON.stringify(b1));
}
{
  const b2 = { lastMessageId: "old", turns: 3, pending: null };
  recordOutcome(b2, { messageId: "u1", ok: false, phId: "p1", finalText: "F", now: 1000 });
  check("N 送达失败 → 水位照样推进（否则整条 pollOnce 重跑 = 刷屏）",
    b2.lastMessageId === "u1", `lastMessageId=${b2.lastMessageId}`);
  check("N 送达失败 → 结果挂进 pending 等待补投",
    b2.pending && b2.pending.messageId === "u1" && b2.pending.finalText === "F" && b2.pending.phId === "p1",
    JSON.stringify(b2.pending));
  check("N 送达失败 → pending 带退避时间，不是立刻重试",
    b2.pending.nextTryAt === 1000 + RETRY_BASE_MS, `nextTryAt=${b2.pending.nextTryAt}`);
  check("N 送达失败 → pending 记录了已试次数", b2.pending.attempts === 1);
}
{
  // 曾经有 pending 时又被一次成功投递清掉，不能留脏状态
  const b3 = { lastMessageId: "old", turns: 0, pending: { messageId: "u0", attempts: 3 } };
  recordOutcome(b3, { messageId: "u2", ok: true, finalText: "F" });
  check("N 成功时清掉旧 pending", b3.pending === null);
}
{
  // 附件路径要被记下来（下载目录要能追溯）
  const b4 = { lastMessageId: "old", turns: 0 };
  recordOutcome(b4, { messageId: "u1", ok: true, paths: ["a.jpg", "b.pdf"] });
  check("N 附件路径被记录", Array.isArray(b4.lastFiles) && b4.lastFiles.length === 2);
  check("N 轮次自增", b4.turns === 1, `turns=${b4.turns}`);
}

// ── O. 静态护栏：源码里绝不能再出现 cmd.exe / shell:true ──
{
  const src = readFileSync(new URL("./mcode-feishu-bridge.mjs", import.meta.url), "utf8");
  // 去掉块注释和行注释再查，否则文档里提到 cmd.exe 会误报
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("O 源码里没有 cmd.exe（回到 shell 转发 = 双重解析 bug 复现）",
    !/cmd\.exe/.test(codeOnly), "发现 cmd.exe");
  check("O 源码里没有 shell: true", !/shell\s*:\s*true/.test(codeOnly), "发现 shell:true");
  // 逐个 spawn 调用的参数里都必须没有 shell:true
  const spawnBlocks = codeOnly.split(/spawn\(/).slice(1);
  const anyShellTrue = spawnBlocks.some(b => /shell\s*:\s*true/.test(b.slice(0, 200)));
  check("O 每个 spawn 的参数里都没有 shell:true", !anyShellTrue);
  check("O 确实存在 spawn 调用（否则上面的检查是空转）", spawnBlocks.length >= 2, `spawn 次数=${spawnBlocks.length}`);
}

// ── P. 单实例锁：活着就拒绝，僵尸锁要能回收，只删自己的锁 ──
{
  const f = join(tmpdir(), `fmb-lock-${process.pid}-a.lock`);
  const l1 = acquireLock(f);
  check("P 首次加锁成功", l1.ok === true && l1.pid === process.pid);

  const l2 = acquireLock(f);
  check("P 同一进程重复加锁视为自己（幂等，不阻塞）", l2.ok === true, JSON.stringify(l2));

  // 用一个真起着的子进程当"别人的锁"。
  // 曾经写死 pid 1 一定活着——Windows 上根本没有 PID 1，会被当成僵尸锁回收，
  // 测试就假绿了。所以这里必须真起一个进程。
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"],
    { shell: false, windowsHide: true, stdio: "ignore" });
  releaseLock(f);
  await new Promise(r => setTimeout(r, 300));      // 等它真的起来
  check("P 前置：子进程确实活着", isPidAlive(child.pid) === true, `pid=${child.pid}`);

  writeFileSync(f, String(child.pid));
  const l3 = acquireLock(f);
  check("P 别的活进程持锁 → 拒绝启动", l3.ok === false && l3.pid === child.pid, JSON.stringify(l3));

  // 僵尸锁：pid 是个几乎不可能存在的大数
  writeFileSync(f, "4194300");
  const l4 = acquireLock(f);
  check("P 僵尸锁（进程已死）→ 自动回收并接管", l4.ok === true, JSON.stringify(l4));

  // 只删自己的锁
  writeFileSync(f, "999999");
  releaseLock(f);
  check("P releaseLock 不误删别人的锁", existsSync(f), "锁被误删");

  child.kill();
  await new Promise(r => setTimeout(r, 200));
  check("P 清理：子进程已回收", isPidAlive(child.pid) === false);
  try { unlinkSync(f); } catch {}
  check("P 锁文件已清理", existsSync(f) === false);

  check("P isPidAlive 对自己为真", isPidAlive(process.pid) === true);
  check("P isPidAlive 对明显不存在的 pid 为假", isPidAlive(2147483647) === false);
  check("P isPidAlive 对垃圾输入为假",
    [0, -1, NaN, "abc", null, undefined, 1.5].every(v => isPidAlive(v) === false));
}

// ── Q. mcode hard timeout: one real run with a 1.5s budget (a real turn needs ~11s).
//    Skipped when this host has no mcode, which is the normal case on CI. ──
{
  check("Q 默认超时有值且合理（1~60 分钟）",
    MCODE_TIMEOUT_MS >= 60000 && MCODE_TIMEOUT_MS <= 3600000, `default=${MCODE_TIMEOUT_MS}`);

  if (!resolveMcodeCli()) {
    skip("Q mcode 未安装，跳过真实超时用例（CI 上没有 mcode）");
  } else {
    const wd = mkdtempSync(join(tmpdir(), "fmb-timeout-"));
    let sawTimeoutEvent = false;
    const t0 = Date.now();
    const r = await mcodeRun("写一句话：你好", { cwd: wd, timeoutMs: 1500, onProgress: (k) => { if (k === "timeout") sawTimeoutEvent = true; } });
    const elapsed = Date.now() - t0;
    check("Q 超时被标记", r.timedOut === true, JSON.stringify({ timedOut: r.timedOut, code: r.code }));
    check("Q 退出码是 -2（专用超时码，不是普通失败）", r.code === -2, `code=${r.code}`);
    check("Q onProgress 收到了 timeout 事件", sawTimeoutEvent === true);
    check("Q 超时提示含秒数，便于用户判断", /\d+s/.test(r.stderr || ""), JSON.stringify(r.stderr));
    check("Q 及时返回（不等到 mcode 自己结束）", elapsed < 8000, `elapsed=${elapsed}ms`);
    // 清理失败也要能跑完（被杀进程的句柄可能还没释放），但要能看出是哪种情况
    let removed = true;
    try { rmSync(wd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { removed = false; }
    check("Q 超时后子进程已退出，临时目录可删（没留僵尸句柄）", removed === true,
      "目录删不掉，说明 mcode 进程还占着句柄");
  }
}

// ── T. selectFresh：水位切分新消息 ──
{
  const mk = (n) => ({ message_id: `om_${n}`, create_time: `t${n}` });
  const pageDesc = [mk(10), mk(9), mk(8), mk(7)];      // desc（最新在前）
  const r1 = selectFresh(pageDesc, "om_8");
  check("T desc 页被翻转成正序",
    r1.fresh.map(m => m.message_id).join(",") === "om_9,om_10",
    r1.fresh.map(m => m.message_id).join(","));
  check("T 命中水位时 watermarkFound=true", r1.watermarkFound === true);

  const r2 = selectFresh(pageDesc, null);
  check("T 没有水位（首轮）→ 全部当新消息", r2.fresh.length === 4 && r2.watermarkFound === true);

  const r3 = selectFresh(pageDesc, "om_10");         // 水位就是最新那条
  check("T 水位=最新 → 没有新消息", r3.fresh.length === 0 && r3.watermarkFound === true);

  const r4 = selectFresh(pageDesc, "om_1");          // 水位太老，不在这一页
  check("T 水位不在页内 → fresh 为空", r4.fresh.length === 0);
  check("T 水位不在页内 → watermarkFound=false（必须触发翻页）", r4.watermarkFound === false,
    "这里如果错成 true，bridge 就会静默丢消息");
}

// ── U. 回归：真实场景复现（会话消息超过一页，bridge 会变聋） ──
{
  // 复刻这次的现场：--order asc --page-size 50 拿到的是最老 50 条，
  // 水位恰好是最后一条 → fresh=[]，用户 16:41 的 hello 被静默吞掉。
  const oldest = Array.from({ length: 50 }, (_, i) => ({
    message_id: `om_old${i}`, create_time: `2026-10-01 14:${String(45 + i).padStart(2, "0")}`,
  }));
  // desc 页 = 最新在前。bridge 发的占位比用户消息晚，所以 placeholder 更新。
  const realNewest = [
    { message_id: "om_placeholder", create_time: "2026-10-01 16:41" },
    { message_id: "om_hello", create_time: "2026-10-01 16:41" },
  ];
  const watermark = "om_old49";

  // 旧行为：直接对 asc 页做 findIndex
  const oldIdx = oldest.findIndex(m => m.message_id === watermark);
  const oldFresh = oldIdx >= 0 ? oldest.slice(oldIdx + 1) : [];
  check("U 旧行为确实漏掉了（负向对照成立）",
    oldFresh.length === 0 && realNewest.length > 0, `oldFresh=${oldFresh.length}`);

  // 新行为：先取最近一页 desc，命中不了才升级全量
  const page1 = selectFresh(realNewest, watermark);
  check("U 最近一页没命中水位 → watermarkFound=false（触发升级）",
    page1.watermarkFound === false);
  const escalated = selectFresh([...realNewest, ...[...oldest].reverse()], watermark);
  check("U 升级全量后能取到那两条新消息",
    escalated.fresh.map(m => m.message_id).join(",") === "om_hello,om_placeholder",
    escalated.fresh.map(m => m.message_id).join(","));
}

// ── V. 源码静态护栏：取消息必须走 desc + 水位升级，不能退回 asc 单页 ──
{
  const src = readFileSync(new URL("./mcode-feishu-bridge.mjs", import.meta.url), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const listCalls = [...codeOnly.matchAll(/\+chat-messages-list[\s\S]{0,320}?\]/g)].map(m => m[0]);
  check("V 存在取消息调用", listCalls.length >= 1, `找到 ${listCalls.length} 处`);
  const bareAsc = listCalls.filter(c => /--order",\s*"asc"/.test(c) && !/--page-all/.test(c));
  check("V 没有「asc 且不带 --page-all」的取消息调用（那正是本次失聪的根因）",
    bareAsc.length === 0, `${bareAsc.length} 处`);
  const hasDesc = listCalls.some(c => /--order",\s*"desc"/.test(c) && /--page-size/.test(c));
  check("V 常态路径是 desc + 限页（一次 API 调用）", hasDesc === true);
}

// ── W. 取消息出问题必须「响」——分类 + 抛异常，两头都不能省 ──
{
  const e1 = reportFetchProblem({ error: true, watermarkFound: true, watermark: "om_x" });
  check("W lark-cli 失败 → 判为 fetch-error", e1.ok === false && e1.reason === "fetch-error", JSON.stringify(e1));
  check("W 失败原因含排查提示（token/网络/权限）", /token|网络|权限/.test(e1.message || ""), e1.message);

  const e2 = reportFetchProblem({ error: false, watermarkFound: false, watermark: "om_x" });
  check("W 水位不在页内 → 判为 no-watermark", e2.ok === false && e2.reason === "no-watermark", JSON.stringify(e2));
  check("W 原因里带上水位 id 方便定位", (e2.message || "").includes("om_x"), e2.message);

  const e3 = reportFetchProblem({ error: false, watermarkFound: true, watermark: "om_x" });
  check("W 一切正常 → ok", e3.ok === true && e3.reason === "ok");

  // 关键：pollOnce 不能靠"记得检查返回值"来保证响，必须靠抛异常。
  // 下面直接打真实的 collectFresh（注入假 fetch），不内联模拟逻辑。
  const mk = (msgs, err = false) => async () => ({ messages: msgs, caughtUp: true, error: err });
  // desc 页 = 最新在前。om_b 比 om_a 新，所以 om_a 是水位、水位后面有 om_b。
  const two = [{ message_id: "om_b" }, { message_id: "om_a" }];

  let threw1 = null;
  try { await collectFresh("c", "om_wm", { fetch: mk([]) }); }
  catch (e) { threw1 = e; }
  check("W 真 collectFresh：空页 → 抛异常（不是静默返回空）", !!threw1, `got ${threw1}`);
  check("W 空页即使 error 标志没置，也判为取消息失败",
    threw1?.reason === "fetch-error", String(threw1?.reason));
  check("W 异常 message 含排查提示", /token|网络|权限/.test(threw1?.message || ""), threw1?.message);

  let threw1b = null;
  try { await collectFresh("c", "om_wm", { fetch: mk([], true) }); }
  catch (e) { threw1b = e; }
  check("W fetch 明确报错 → 同样是 fetch-error", threw1b?.reason === "fetch-error", String(threw1b?.reason));

  let threw2 = null;
  try { await collectFresh("c", "om_missing", { fetch: mk(two) }); }
  catch (e) { threw2 = e; }
  check("W 真 collectFresh：水位不在页内 → 抛异常",
    !!threw2 && threw2?.reason === "no-watermark", String(threw2));
  check("W 异常 message 带水位 id", (threw2?.message || "").includes("om_missing"), threw2?.message);

  const okRes = await collectFresh("c", "om_a", { fetch: mk(two) });
  check("W 真 collectFresh：正常 → 返回新消息且不抛",
    okRes.fresh.map(m => m.message_id).join(",") === "om_b" && okRes.caughtUp === true,
    JSON.stringify(okRes.fresh));
}

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
