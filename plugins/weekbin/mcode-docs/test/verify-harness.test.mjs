import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSemaphore, runClaim, runCommand, buildSourceIndex, resetSourceIndex } from '../verify/lib/harness.mjs';
import { displayWidth, summarize } from '../verify/lib/report.mjs';

// verify/ 自身的机械回归。
//
// 边界:这里只测 harness 的**逻辑**,不测 claim 的**内容**。
// claim 内容需要 mcode 与其随包源码,跑得慢且依赖环境,归 verify/run.mjs 与 CI;
// 放进 npm test 会让每个提交都付出装 mcode 的代价,也会在没有 mcode 的机器上误红。
//
// 判据:一个从未见过红的检查器等于没检查。所以下面大半用例是**故意写错的 claim**,
// 断言它们必须落到预期的四种状态之一。

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, '..', 'verify');
const DOMAIN_DIR = join(VERIFY, 'domains');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 ctx:够跑 doc/source/exec 三类检查,不碰真实环境。 */
function makeCtx(overrides = {}) {
  return {
    version: '0.0.0-test',
    source: null,
    docs: { zh: '中文正文 stream-json', en: 'English body stream-json' },
    semaphore: createSemaphore(4),
    defaultTimeoutMs: 5000,
    cwd: HERE,
    ...overrides,
  };
}

/* ------------------------------------------------------------ 四态收敛 */

test('空 checks 收敛为 uncovered,而不是 pass', async () => {
  const r = await runClaim({ id: 'a', domain: 'd', claim: 'x', checks: [] }, makeCtx());
  assert.equal(r.status, 'uncovered');
});

test('checks 缺失(非数组)同样收敛为 uncovered', async () => {
  const r = await runClaim({ id: 'a', domain: 'd', claim: 'x' }, makeCtx());
  assert.equal(r.status, 'uncovered');
});

test('未知 check.kind 记 fail,不是静默通过', async () => {
  const r = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'telepathy' }] },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
});

test('一个检查抛错不掩盖同 claim 其他检查的真实结果', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [{ kind: 'doc', text: 'stream-json' }, { kind: 'telepathy' }],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
  // 抛错的那条 fail,通过的那条仍须留下 pass 记录,而不是一起消失
  assert.equal(r.checks.length, 2);
  assert.equal(r.checks.filter((c) => c.ok).length, 1);
});

test('源码缺失只能 skip,不能算 pass', async () => {
  const r = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'source', pattern: 'anything' }] },
    makeCtx({ source: null }),
  );
  assert.equal(r.status, 'skip');
});

test('部分 skip 且其余全过仍算 pass —— skip 是没验成,不是验伪', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [{ kind: 'doc', text: 'stream-json' }, { kind: 'source', pattern: 'anything' }],
    },
    makeCtx({ source: null }),
  );
  assert.equal(r.status, 'pass');
});

test('doc 检查对 zh / en 双站分别判定,只缺一站即 fail', async () => {
  const r = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'doc', text: 'only-in-zh 中文' }] },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /en/);
});

test('ref 检查读参考手册,不牵连站点双站', async () => {
  const ctx = makeCtx({ refs: { 'cli.md': '基线 0.5.8 与 Node 要求' } });

  const hit = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'doc', ref: 'cli.md', text: '0.5.8' }] },
    ctx,
  );
  assert.equal(hit.status, 'pass', hit.reason);

  // 「0.5.8」在站点正文里没有 —— ref 检查不该因此失败
  const onlyRef = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'doc', ref: 'cli.md', text: '基线 0.5.8' }] },
    makeCtx({ refs: { 'cli.md': '基线 0.5.8 与 Node 要求' } }),
  );
  assert.equal(onlyRef.status, 'pass', onlyRef.reason);
});

test('ref 指向未登记的参考手册记 fail,不是静默通过', async () => {
  const r = await runClaim(
    { id: 'a', domain: 'd', claim: 'x', checks: [{ kind: 'doc', ref: 'nope.md', text: 'x' }] },
    makeCtx({ refs: {} }),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /nope\.md/);
});

/* ------------------------------------------------------------ 元数据兜底 */

test('claim 元数据抛错时退化为该条 fail,不掀翻整轮运行', async () => {
  const bad = {
    id: 'a',
    domain: 'd',
    get claim() {
      throw new Error('元数据炸了');
    },
    checks: [{ kind: 'doc', text: 'stream-json' }],
  };
  const r = await runClaim(bad, makeCtx());
  // 元数据取不到 → 退回占位串,但检查本身仍照跑并记结果
  assert.equal(typeof r.claim, 'string');
  assert.equal(r.status, 'pass');
});

/* ------------------------------------------------------------ 信号量 */

test('信号量真的限并发,而不是只记个数', async () => {
  const sem = createSemaphore(2);
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      await sem.next();
      live++;
      peak = Math.max(peak, live);
      await sleep(5);
      live--;
      sem.release();
    }),
  );
  assert.equal(peak, 2, `峰值并发应为 2,实际 ${peak}`);
});

test('信号量在异常路径下也必须释放,否则会死锁', async () => {
  const sem = createSemaphore(1);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      sem
        .next()
        .then(() => {
          if (i % 2) throw new Error('炸');
          return 'ok';
        })
        .finally(() => sem.release()),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(sem.active, 0);
});

/* ------------------------------------------------------------ exec 断言原语 */

test('命令不存在记 skip,并与行为不符区分开', async () => {
  const r = await runCommand('definitely-not-a-real-binary-xyz-9f2', ['--help']);
  assert.equal(r.missing, true);
  assert.equal(r.ok, false);
});

test('超时被捕获,不留悬挂进程', async () => {
  const started = Date.now();
  const r = await runCommand('sleep', ['30'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, '超时未在预期内生效');
});

/* ------------------------------------------------------------ flagSet 双向 */

test('flagSet 双向相等:能查出 help 里多出的未文档化选项', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("  --alpha\\n  --beta\\n  --gamma\\n")'],
          flagSet: ['--alpha', '--beta'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /多出/);
  assert.match(r.reason, /--gamma/);
});

test('flagSet 双向相等:能查出声明了但 help 里没有的选项', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("  --alpha\\n")'],
          flagSet: ['--alpha', '--beta'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /缺少/);
  assert.match(r.reason, /--beta/);
});

test('flagSetExempt 把已知有意不文档化的选项排除出「多出」', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("  --alpha\\n  --internal-lane\\n")'],
          flagSet: ['--alpha'],
          flagSetExempt: ['--internal-lane'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'pass', r.reason);
});

test('--help 自身永远不比对,否则每个 claim 都会误报', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("  --alpha\\n  -h, --help\\n")'],
          flagSet: ['--alpha'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'pass', r.reason);
});

test('notIn 接受数组,逐条判定', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("--session --input --safe")'],
          notIn: ['--session', '--input', '--never-printed'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'fail');
  assert.match(r.reason, /--session/);
});

test('notIn 为数组时不再抛 .test is not a function', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [
        {
          kind: 'exec',
          cmd: 'node',
          args: ['-e', 'console.log("--only")'],
          notIn: ['--absent'],
        },
      ],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'pass', r.reason);
});

test('输出尾随换行不影响锚定断言', async () => {
  const r = await runClaim(
    {
      id: 'a',
      domain: 'd',
      claim: 'x',
      checks: [{ kind: 'exec', cmd: 'node', args: ['-e', 'console.log("0.5.8")'], expect: /^0\.5\.8$/ }],
    },
    makeCtx(),
  );
  assert.equal(r.status, 'pass', r.reason);
});

/* ------------------------------------------------------------ 报告 */

test('displayWidth 把 CJK 记为 2 列', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('参数'), 4);
  assert.equal(displayWidth('a参b'), 4);
});

test('summarize 永远给出五个数,uncovered 不被并进 pass', () => {
  const c = summarize([
    { status: 'pass' },
    { status: 'pass' },
    { status: 'fail' },
    { status: 'skip' },
    { status: 'uncovered' },
  ]);
  assert.deepEqual(c, { total: 5, pass: 2, fail: 1, skip: 1, uncovered: 1 });
});

/* ------------------------------------------------------------ 域定义自检 */

const domainFiles = readdirSync(DOMAIN_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort();

test('至少存在一个域定义,否则 --domain 过滤会静默跑空', () => {
  assert.ok(domainFiles.length > 0, 'verify/domains 下没有 .mjs');
});

test('每条 claim 必填 id / domain / claim / doc,且 id 全局唯一', async () => {
  const seen = new Map();
  const problems = [];

  for (const file of domainFiles) {
    const mod = await import(join(DOMAIN_DIR, file));
    for (const claim of mod.claims ?? []) {
      for (const field of ['id', 'domain', 'claim', 'doc']) {
        if (typeof claim[field] !== 'string' || claim[field].length === 0) {
          problems.push(`${file}:${claim.id ?? '?'} 缺 ${field}`);
        }
      }
      if (seen.has(claim.id)) problems.push(`id 重复:${claim.id} (${seen.get(claim.id)} 与 ${file})`);
      else seen.set(claim.id, file);

      if (!Array.isArray(claim.checks) || claim.checks.length === 0) {
        problems.push(`${file}:${claim.id} 没有 checks —— 会静默算 uncovered`);
      }
      for (const c of claim.checks ?? []) {
        if (!['doc', 'source', 'exec'].includes(c.kind)) {
          problems.push(`${file}:${claim.id} 未知 check.kind:${c.kind}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('claim 的 doc 回链真实存在:站内页查锚点,库内文件查磁盘', async () => {
  const ROOT = join(HERE, '..');
  const siteDir = join(ROOT, 'site');
  const pages = {
    'site/index.html': readFileSync(join(siteDir, 'index.html'), 'utf-8'),
    'site/index.en.html': readFileSync(join(siteDir, 'index.en.html'), 'utf-8'),
  };
  const problems = [];

  for (const file of domainFiles) {
    const mod = await import(join(DOMAIN_DIR, file));
    for (const claim of mod.claims ?? []) {
      const [path, anchor] = String(claim.doc).split('#');
      const html = pages[path];
      if (html !== undefined) {
        // 站内页:锚点必须真实存在,否则报告里的回链点开是死路
        if (anchor && !html.includes(`id="${anchor}"`)) {
          problems.push(`${claim.id}: 页面 ${path} 里没有锚点 #${anchor}`);
        }
        continue;
      }
      // 库内文件(reference/*.md、VERIFICATION.md 等):只要求文件存在
      if (!existsSync(join(ROOT, path))) {
        problems.push(`${claim.id}: doc 指向不存在的路径 ${path}`);
      }
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

/* ------------------------------------------------------------ 源码索引 */

test('源码索引可重建,且大小写敏感 —— 符号名区分大小写', () => {
  resetSourceIndex();
  const idx = buildSourceIndex([join(VERIFY, 'lib', 'report.mjs')]);
  assert.equal(idx.entries.length, 1);
  assert.ok(idx.entries[0].text.includes('displayWidth'));
  assert.ok(!idx.entries[0].text.includes('DISPLAYWIDTH'));
  resetSourceIndex();
});
