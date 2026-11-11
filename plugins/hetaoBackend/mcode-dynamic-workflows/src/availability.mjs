import { spawn } from 'node:child_process';
import { executablePath, resolveMcode } from './mcode-location.mjs';
import { stopProcessTree } from './process-tree.mjs';
import { safeDetail } from './failure.mjs';
import { check } from './common.mjs';
export { executablePath, resolveMcode };
// Fail-loud preflight. Field evidence (2026-09-20, this machine): during a
// broken-CLI window (better-sqlite3 ABI break + mcode v0.2.4) three runs
// persisted run.started → run.finished(succeeded) within 42ms with
// attempts:0, steps:0, errorDetails:null and a valid topology containing
// planned agent nodes — the executor layer was completely dead and the engine
// translated that into success. Resolution alone cannot see this class: the
// CLI file exists and resolves; the process dies on startup. This probe runs
// the resolved entry with --version — a cheap liveness check that NEVER
// invokes a model — so an unusable CLI fails the run before any dispatch,
// with actionable details, instead of being translated into success.
// Tree-aware timeout (PR #57 review): the probe used to kill only the root
// with SIGKILL and then wait for `error`/`close`. Descendants that inherited
// the probe's stdout/stderr pipes could withhold `close` forever, so
// engine.approve() could hang past the advertised watchdog and the tree could
// leak. The timeout path now shares the real executor's contract
// (src/executor.mjs): spawn into a dedicated POSIX process group, stop the
// whole owned tree via stopProcessTree, destroy the pipes once cleanup
// settles, and converge independently of `close` within a fixed cleanup
// budget — failing closed as MCODE_PREFLIGHT_FAILED (probe timeout vs
// cleanup-unconfirmed) on every path.
const CLEANUP_BUDGET_MS = 5000;
export async function preflightMcode(command = 'mcode', { args = [], env = process.env, timeoutMs = 20000, stopTree = stopProcessTree } = {}) {
  check(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 600_000, 'preflightTimeoutMs 必须是 100–600000 范围内的整数毫秒值');
  let cli = null;
  try { cli = await resolveMcode(command, { env }); }
  catch (e) {
    return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: null,
      message: `MCode CLI 解析失败：${safeDetail(e.message)}`,
      suggestion: '修复该 CLI 安装后重试；本次运行未执行任何 Agent。' };
  }
  if (!cli) {
    return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: null,
      message: '找不到 MCode CLI，请通过官方渠道安装并登录，再按 Skill 的 CLI preflight 检查 mcode --version 和 mcode exec --help。',
      suggestion: '安装或修复 mcode 后重试；本次运行未执行任何 Agent。' };
  }
  // Cheap liveness probe only: --version never starts a model call.
  const probe = await new Promise(resolve => {
    const captured = { stdout: '', stderr: '' };
    let timedOut = false, settled = false;
    // Executor-aligned spawn: the dedicated POSIX process group is the
    // precondition for stopProcessTree's group signalling; win32 stays
    // attached so taskkill /T can discover the tree from the live root.
    const child = spawn(cli.command, [...cli.args, ...args, '--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let timer = null, cleanupTimer = null;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); resolve(result); };
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { const text = captured[key]; captured[key] = text.length + chunk.length > 8000 ? text : text + chunk; });
    }
    // Once the watchdog has fired, `close`/`error` are no longer settle
    // paths: pipe-inheriting descendants can withhold them indefinitely, so
    // the probe converges exclusively on the bounded cleanup below.
    child.on('error', e => { if (timedOut) return; finish({ exitCode: null, spawnError: e.code ?? safeDetail(e.message), ...captured, timedOut }); });
    child.on('close', exitCode => { if (timedOut) return; finish({ exitCode, spawnError: null, ...captured, timedOut }); });
    timer = setTimeout(() => {
      timedOut = true;
      // Independently bounded, tree-aware cleanup. stopProcessTree's own
      // worst case is ~2s SIGTERM grace + ~1s SIGKILL force + process-table
      // probe slop (≤1s per bounded ps call; win32 taskkill 3s) ≈ 4–6s. A
      // fixed 5s budget covers the normal escalation with headroom; if a
      // hostile tail exceeds it, stop waiting and fail closed as
      // cleanup-unconfirmed — never hang on `close`.
      const cleanup = stopTree(child);
      const settle = (cleanupConfirmed, reason) => {
        // Inherited pipes must not outlive the probe's verdict.
        child.stdout?.destroy(); child.stderr?.destroy();
        finish({ exitCode: child.exitCode, spawnError: null, ...captured, timedOut, cleanupConfirmed, ...(reason ? { cleanupReason: reason } : {}) });
      };
      void cleanup.then(
        result => { clearTimeout(cleanupTimer); settle(result.confirmed, result.confirmed ? null : safeDetail(result.reason)); },
        // stopProcessTree never rejects by construction; guard injected fakes.
        () => settle(false, '清理操作自身失败'));
      cleanupTimer = setTimeout(() => settle(false, `停止确认未在清理预算（${CLEANUP_BUDGET_MS}ms）内落定`), CLEANUP_BUDGET_MS);
      cleanupTimer.unref();
    }, timeoutMs);
    timer.unref();
  });
  if (probe.exitCode === 0 && !probe.spawnError && !probe.timedOut) {
    return { ok: true, executor: 'mcode', probe: '--version', source: cli.source, checkedAt: Date.now(),
      version: probe.stdout.trim().split('\n').pop()?.slice(0, 120) || null };
  }
  const tail = safeDetail(probe.stderr.trim() || probe.stdout.trim()).slice(-300);
  if (probe.timedOut && !probe.cleanupConfirmed) {
    return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: '--version',
      exitCode: probe.exitCode, spawnError: probe.spawnError, cleanupConfirmed: false, cleanupReason: probe.cleanupReason ?? null, ...(tail ? { stderr: tail } : {}),
      message: `MCode CLI 不可用：探测超时（超过 ${Math.round(timeoutMs / 1000)} 秒未退出），且无法确认进程树已停止（${probe.cleanupReason ?? '原因未知'}）。请检查并结束后残留的 mcode 及其子进程后重试。本次运行已按失败处理，未执行任何 Agent。`,
      suggestion: '先在终端运行 mcode --version 确认状态；若命令卡死，先结束残留的 mcode 及其子进程，修复安装后重试。' };
  }
  const cause = probe.timedOut ? `探测超时（超过 ${Math.round(timeoutMs / 1000)} 秒未退出，进程树已确认停止）`
    : probe.spawnError ? `无法启动（${probe.spawnError}）`
    : `mcode --version 退出码 ${probe.exitCode ?? '未知'}`;
  return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: '--version',
    exitCode: probe.exitCode, spawnError: probe.spawnError, ...(probe.timedOut ? { cleanupConfirmed: probe.cleanupConfirmed } : {}), ...(tail ? { stderr: tail } : {}),
    message: `MCode CLI 不可用：${cause}${tail ? `：${tail}` : ''}。本次运行已按失败处理，未执行任何 Agent。`,
    suggestion: '先在终端运行 mcode --version 确认可用：检查 mcode 安装与升级（版本损坏或原生模块不匹配时重装）、登录状态与网络，修复后恢复运行。' };
}
