import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 手册呈现纪律的机械回归检查。
// 来源:用户级 skill `technical-doc-discipline`。
//
// linter 在此停下——以下三类不写进断言,因为需要语义判断,由人工审:
//   1. 某个破折号是否承重(参考手册的「术语 — 定义」列表、表格空值、中文国标 —— 都合法)
//   2. 某句话是否真的在帮读者完成任务
//   3. 一个数字是「闭合集事实」(白名单只有 17 个)还是「自述计数」(共 52 条)
// 判据写在技能正文里,不在此复制。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

// 读者手册:全部呈现规则适用。
const MANUAL = ['site/index.html', 'site/index.en.html'];
// 参考文档:逐条主张不得挂证据等级标记。
const REFERENCE = [
  'skills/mcode-docs/reference/agents-skills.md',
  'skills/mcode-docs/reference/cli.md',
  'skills/mcode-docs/reference/commands.md',
  'skills/mcode-docs/reference/config.md',
  'skills/mcode-docs/reference/coverage.md',
  'skills/mcode-docs/reference/mcp-tools.md',
  'skills/mcode-docs/reference/miniapp.md',
  'skills/mcode-docs/reference/permissions.md',
  'skills/mcode-docs/reference/plugins.md',
];
// 工作契约:允许描述证据体系本身,禁止交付史叙事与自述计数。
const CONTRACT = ['skills/mcode-docs/SKILL.md', 'README.md', 'README.zh-CN.md'];

function each(files, fn) {
  const out = [];
  for (const f of files) for (const hit of fn(read(f), f)) out.push(`${f}: ${hit}`);
  return out;
}

test('手册不出现取证痕迹:证据等级与逐条实跑声明', () => {
  const banned = [
    /（[ABCD]\s*级/,
    /\([ABCD]\s*level/i,
    /\bgraded [ABCD]\b/i,
    /证据等级/,
    /实跑通过/,
    /在本机\s*[\d.]+\s*实跑/,
    /actually run against/i,
  ];
  const hits = each([...MANUAL, ...REFERENCE], (text, f) =>
    banned.flatMap((re) => {
      const m = text.match(re);
      return m ? [`${JSON.stringify(m[0])}`] : [];
    }),
  );
  assert.deepEqual(hits, [], `取证痕迹回流:\n${hits.join('\n')}`);
});

test('手册与参考文档不出现交付史叙事', () => {
  const banned = [
    /不再[是凡]/,
    /早期描述/,
    /改为使用/,
    /\bno longer\b/i,
    /\bused to be\b/i,
    /\bformerly\b/i,
    /\bpreviously\b/i,
  ];
  const hits = each([...MANUAL, ...REFERENCE, ...CONTRACT], (text, f) =>
    banned.flatMap((re) => {
      const m = text.match(re);
      return m ? [`${JSON.stringify(m[0])}`]
        // /changelog 是 mcode 的 TUI 命令名,不是交付史叙事。
        : [];
    }).filter((h) => !/changelog/i.test(h)),
  );
  assert.deepEqual(hits, [], `交付史叙事回流:\n${hits.join('\n')}`);
});

test('手册不出现括号裸计数(标题计数、表尾条数)', () => {
  const re = /[（(]\s*\d+\s*[条个项类种]\s*[)）]/;
  const hits = each([...MANUAL, ...REFERENCE, ...CONTRACT], (text) => {
    const m = text.match(re);
    return m ? [`${JSON.stringify(m[0])}`] : [];
  });
  assert.deepEqual(hits, [], `括号裸计数回流:\n${hits.join('\n')}`);
});

test('已废弃译名不复活:Session 浏览器', () => {
  const hits = each([...MANUAL, ...REFERENCE, ...CONTRACT], (text) => {
    const m = text.match(/Session\s*浏览器|会话浏览器/);
    return m ? [`${JSON.stringify(m[0])}`] : [];
  });
  assert.deepEqual(hits, [], `废弃译名回流:\n${hits.join('\n')}`);
});

test('双语站核心结构配平', () => {
  const zh = read('site/index.html');
  const en = read('site/index.en.html');
  // 单元格数不参与:中文站多出「英文文案/中文文案」两列,该列只在中文站有意义。
  for (const tag of ['div', 'table', 'ul', 'li', 'tr', 'section', 'p', 'h1', 'h2', 'h3', 'h4', 'a', 'span']) {
    const z = (zh.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const e = (en.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    assert.equal(z, e, `<${tag}> 不配平:ZH ${z} / EN ${e}`);
  }
});

test('双语站逐表行数与表数配平', () => {
  const rows = (t) => (t.match(/<table[\s\S]*?<\/table>/g) || []).map((x) => (x.match(/<tr[\s>]/g) || []).length);
  const z = rows(read('site/index.html'));
  const e = rows(read('site/index.en.html'));
  assert.equal(z.length, e.length, `表数不配平:ZH ${z.length} / EN ${e.length}`);
  assert.deepEqual(z, e, '逐表行数不配平');
});
