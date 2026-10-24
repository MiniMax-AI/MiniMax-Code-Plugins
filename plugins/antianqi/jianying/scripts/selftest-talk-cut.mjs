#!/usr/bin/env node
/**
 * jianying-talk-cut 自检：规划器判定 + 落稿链
 *   ① 规划器：水词/长停顿/重复 三类判定 + 保留区间算对
 *   ② 落稿链：split×2+delete ⇒ 时间线正好缩短
 * 用法: node scripts/selftest-talk-cut.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
const WORK = path.join(JYAI, 'out', 'p67', 'talk-cut-selftest');
// ★ 草稿路径不写死任何人的盘符：必须由调用方用 JYAI_TEST_DRAFT 指定。
//   没给时，① 规划器照跑（纯离线），只有 ② 落稿链（需要活的剪映）SKIP。
const DRAFT = process.env.JYAI_TEST_DRAFT || '';

let PASS = 0, FAIL = 0;
const check = (n, ok, d) => {
  if (ok) { PASS++; console.log(`  [PASS] ${n}${d ? '  — ' + d : ''}`); }
  else { FAIL++; console.log(`  [FAIL] ${n}${d ? '  — ' + d : ''}`); }
};
fs.mkdirSync(WORK, { recursive: true });

/* ---------- 造一份含水词/长停顿/重复的 SRT ---------- */
const SRT = path.join(WORK, 'test.srt');
fs.writeFileSync(SRT, [
  '1', '00:00:00,500 --> 00:00:03,200', '嗯，那个，今天我们来聊一聊这个青椒的辣度。', '',
  '2', '00:00:03,400 --> 00:00:05,800', '其实青椒肉丝是特别经典的一道家常菜。', '',
  '3', '00:00:06,900 --> 00:00:09,000', '呃，那个，我个人非常喜欢这个菜。', '',
  '4', '00:00:09,100 --> 00:00:12,000', '其实青椒肉丝是特别经典的一道家常菜。', '',
  '5', '00:00:13,800 --> 00:00:16,200', '这道菜的关键是青椒要够脆、肉丝要够嫩。', '',
  '6', '00:00:16,400 --> 00:00:18,900', '嗯，就是说，火候一定要掌握好。', '',
  '7', '00:00:19,300 --> 00:00:20,100', '嗯，呃。', '',
].join('\n'), 'utf8');

console.log('=== talk-cut 自检 ===\n');

/* ---------- ① 规划器 ---------- */
const planFile = path.join(WORK, 'plan.json');
const p = spawnSync(process.execPath, [path.join(HERE, 'talk-cut-plan.mjs'),
  '--srt', SRT, '--out', planFile], { encoding: 'utf8' });
check('① 规划器跑通', p.status === 0, p.stdout.split('\n').filter((l) => l.includes('drop ')).join('').trim());
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const byIdx = (i) => plan.cues.find((c) => c.index === i);

check('①a 纯水词句判 drop', byIdx(7)?.verdict === 'drop', `#7 = ${byIdx(7)?.verdict}（${byIdx(7)?.reasons?.join('/')}）`);
check('①b 含水词但有实词 → review', byIdx(1)?.verdict === 'review', `#1 = ${byIdx(1)?.verdict}`);
check('①c 隔一条的重复被检出', (plan.duplicates || []).some((d) => d.cue === 4 && d.ofCue === 2),
  JSON.stringify(plan.duplicates));
check('①d 长停顿被检出', (plan.gaps || []).length >= 2, `${(plan.gaps || []).length} 处`);
check('①e 词级水词有时间定位', (byIdx(1)?.fillerSpans || []).length > 0 && byIdx(1).fillerSpans[0].endMs > byIdx(1).fillerSpans[0].startMs,
  JSON.stringify((byIdx(1)?.fillerSpans || []).slice(0, 2)));
const keepTotal = plan.keepRanges.reduce((a, r) => a + (r.endMs - r.startMs), 0);
const dropTotal = plan.dropRanges.reduce((a, r) => a + (r.endMs - r.startMs), 0);
check('①f 保留 + 删除 = 总时长', keepTotal + dropTotal === plan.stats.totalMs,
  `${keepTotal} + ${dropTotal} = ${keepTotal + dropTotal} vs ${plan.stats.totalMs}`);

/* ---------- ② 落稿链（需要活的剪映 + 一个真实草稿）---------- */
if (!DRAFT) {
  console.log('  [SKIP] ② 落稿链 —— 需要 JYAI_TEST_DRAFT（指向一个带视频片段的剪映草稿目录）且剪映在运行。');
  console.log('         例（PowerShell）: $env:JYAI_TEST_DRAFT = "<草稿库>\\<草稿名>"');
} else {
  const cutPlan = path.join(WORK, 'cut-plan.json');
  fs.writeFileSync(cutPlan, JSON.stringify({
    ...plan,
    dropRanges: [{ startMs: 1000, endMs: 2000, reason: '自检：剪掉第一段中间 1 秒' }],
  }, null, 2), 'utf8');

  const a = spawnSync(process.execPath, [path.join(HERE, 'talk-cut-apply.mjs'),
    '--plan', cutPlan, '--draft', DRAFT, '--apply'], { encoding: 'utf8', timeout: 600000 });
  const out = a.stdout || '';
  check('② 落稿链跑通', a.status === 0,
    out.split('\n').filter((l) => /判定|已验证剪掉|这一轨时长总量|\[OK\]|落盘/.test(l)).join(' | ').trim());
  // ★ 判据（2026-10-24 改写）：这一轨的【时长总量】正好少了剪掉的长度
  //   —— 旧判据是"总时长 == 原总时长 − 剪掉量"，但①改前读的是磁盘形态、改后读的是会话快照形态
  //   （段 11 键 vs 50+ 键）⇒ 两种形态混着比 ⇒ 假红；②官方删片段会把后面的段左移补空
  //   ⇒ 总时长也不是可靠判据。现在判据形态无关、且与位移无关。
  check('②a 这一轨的时长总量正好少了剪掉的长度（★ 形态无关的判据）',
    /判定: 已验证剪掉 1\/1 个区间/.test(out) && /这一轨时长总量 \d+ → \d+ us（正好少 1000000）/.test(out),
    (out.match(/# 判定:.*/) || [''])[0].trim() + ' || ' + (out.match(/\[OK\].*/) || [''])[0].trim());
  check('②b 真草稿零改动', /realDraftUnchanged=true/.test(out), (out.match(/# 落盘:.*/) || [''])[0].trim());
  // ★ ②c 阴性对照：演练模式（没 --apply）⇒ 判据必然【不成立】
  //   ⇒ 这一条证明判据【有区分力】："剪了"和"没剪"结论不同（不是恒真）
  const dry = spawnSync(process.execPath, [path.join(HERE, 'talk-cut-apply.mjs'),
    '--plan', cutPlan, '--draft', DRAFT], { encoding: 'utf8', timeout: 600000 });
  const dryOut = dry.stdout || '';
  check('②c 阴性对照：演练模式 ⇒ 判据不成立（证明判据能区分"剪了"和"没剪"）',
    /阴性对照/.test(dryOut) && /判据现在【不成立】/.test(dryOut),
    (dryOut.match(/阴性对照.*/) || [''])[0].trim());
}

console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL === 0 ? 0 : 1);
