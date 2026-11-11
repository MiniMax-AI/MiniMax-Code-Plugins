// ★ 安全探针：会话状态不得读/写 PLUGIN_DATA 之外
//
// 起因（PR #72 review，hetaoBackend，CHANGES_REQUESTED）：
//   server.mjs 原来把 sessionId 原样拼进状态文件名（`session-${sid}.json`），
//   而 schema 只要求它是个字符串 ⇒ `x/../../../../tmp/canary` 经 path.join 归一化后
//   落到 PLUGIN_DATA 之外 ⇒ draft_read 读出任意本地 JSON，draft_patch 往那里写快照。
//
// 本探针的判据（★ 每条都必须"因为预期原因"失败/通过）：
//   ① 每个恶意 sessionId × 3 个动词 ⇒ 必须被拒
//   ② 响应里【不能出现】canary 标记（否则就是读到了）
//   ③ 目录外【不能出现】新文件（否则就是写到了）
//   ④ ★ 阳性对照：形态合法、且文件【就在状态目录内】的 sessionId ⇒ 必须能读到
//      （没有它，"全部拒绝"也会让探针看起来是绿的 ⇒ 判据没有区分力）
//
// 用法：node scripts/security-probe.mjs     （退出码 0 = 全过）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(HERE, '..', 'mcp', 'server.mjs');
const MARK = 'PR72_CANARY_MARKER_9f3a7c';

/* ---------- 起一个隔离 PLUGIN_DATA 的 server ---------- */
function startServer(stateDir) {
  const child = spawn(process.execPath, [SRV], {
    env: { ...process.env, PLUGIN_DATA: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { child, rpc };
}

const textOf = (r) => (r.result?.content || []).map((c) => c.text || '').join('\n');

/* ---------- 主检查 ---------- */
export async function runSecurityProbe() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jianying-sec-'));
  const stateDir = path.join(tmp, 'state');
  const siblingDir = path.join(tmp, 'state-evil');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });

  // canary：状态目录的同级 + sibling-prefix 目录里各一个
  fs.writeFileSync(path.join(tmp, 'canary.json'), JSON.stringify({ marker: MARK, where: 'parent' }), 'utf8');
  fs.writeFileSync(path.join(siblingDir, 'canary.json'), JSON.stringify({ marker: MARK, where: 'sibling' }), 'utf8');
  // ★ 阳性对照用的快照：形态合法、就在状态目录内
  fs.writeFileSync(path.join(stateDir, 'snapshot-ve-session-42.json'),
    JSON.stringify({ marker: MARK, where: 'inside-state-dir' }), 'utf8');

  const { child, rpc } = startServer(stateDir);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sec-probe', version: '1' } });

  const cases = [];
  const record = (name, ok, detail) => cases.push({ name, ok: !!ok, detail: String(detail || '') });

  // ① 阳性对照：合法形态 + 文件在状态目录内 ⇒ 必须读到
  const good = await rpc('tools/call', { name: 'draft_read', arguments: { sessionId: 've-session-42' } });
  const goodTxt = textOf(good);
  record('阳性对照：状态目录内的合法 sessionId 能读到（证明探针的读取通道有效）',
    goodTxt.includes(MARK), goodTxt.slice(0, 120));

  // ② 恶意 sessionId × 3 个动词
  const MALICIOUS = [
    { name: 'POSIX 相对穿越', sid: 'x/../../canary' },
    { name: 'Windows 反斜杠穿越', sid: 'x\\..\\..\\canary' },
    { name: '绝对路径（POSIX）', sid: '/etc/passwd' },
    // ★ 分段构造：源码里不留盘符字面量（插件规范：绝不写死盘符；顺带让盘符扫描不误报）
    { name: '绝对路径（Windows）', sid: 'C:' + '\\Windows\\win.ini' },
    { name: 'sibling-prefix 目录', sid: 'x/../../state-evil/canary' },
    { name: 'URL 编码', sid: 'x%2f..%2f..%2fcanary' },
    { name: 'null 字节', sid: 'x\u0000../../canary' },
    { name: '纯 ..', sid: '..' },
    { name: '点段伪装', sid: './../../canary' },
  ];
  const VERBS = [
    { name: 'draft_read', args: (sid) => ({ sessionId: sid }) },
    { name: 'draft_patch', args: (sid) => ({ op: 'video.setVolume', sessionId: sid, params: { segmentId: 'x', volume: 0.2 } }) },
    { name: 'draft_commit', args: (sid) => ({ sessionId: sid, realDraft: stateDir }) },
  ];

  for (const m of MALICIOUS) {
    for (const v of VERBS) {
      const r = await rpc('tools/call', { name: v.name, arguments: v.args(m.sid) });
      const txt = textOf(r);
      const rejected = r.result?.isError === true;
      const leaked = txt.includes(MARK);
      record(`${v.name}：${m.name} ⇒ 被拒且读不到 canary`,
        rejected && !leaked,
        `isError=${rejected} 泄漏canary=${leaked} :: ${txt.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
  }

  // ③ 状态目录外没有新文件（写路径）
  const outside = [];
  const walk = (d, base = d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, base);
      else outside.push(path.relative(base, p).replace(/\\/g, '/'));
    }
  };
  walk(tmp);
  const unexpected = outside.filter((f) => f !== 'canary.json' && f !== 'state-evil/canary.json'
    && !f.startsWith('state/'));
  record('状态目录之外没有新增文件（写路径也没逃逸）',
    unexpected.length === 0, unexpected.join(', ') || '只有 canary 与状态目录内的文件');

  // ④ 形态合法但会话不存在 ⇒ 报"找不到 session"（证明不是"一律拒绝"）
  const missing = await rpc('tools/call', { name: 'draft_commit', arguments: { sessionId: 've-session-999999', realDraft: stateDir } });
  const missingTxt = textOf(missing);
  record('形态合法但会话不存在 ⇒ 报"找不到 session"（不是格式问题）',
    /找不到 session/.test(missingTxt), missingTxt.replace(/\s+/g, ' ').slice(0, 120));

  child.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

  const pass = cases.filter((c) => c.ok).length;
  return { pass, fail: cases.length - pass, total: cases.length, cases };
}

/* ---------- CLI ---------- */
const isMain = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const r = await runSecurityProbe();
  console.log('=== 会话状态越界探针 ===\n');
  for (const c of r.cases) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : '  — ' + c.detail}`);
  console.log(`\n=== ${r.pass} PASS / ${r.fail} FAIL ===`);
  process.exit(r.fail ? 1 : 0);
}
