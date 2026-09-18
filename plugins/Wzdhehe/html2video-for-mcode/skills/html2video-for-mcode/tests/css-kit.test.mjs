// CSS 工具箱受管块: "块在但内容旧"必须被发现并原地修复。
// 这是"改了 CSS 但项目里没生效"的根因回归 —— 2026-09-18 双代理审计定案: 旧判定只探
// 1–2 个标记字符串, 项目补过一次后就永远报"无需升级"(源模块后续改动永不传播);
// 追加式升级还会压掉项目端覆写并留下整份重复块。本文件逐条锁死这些行为。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, mkproj, tmpdir, SCRIPTS } from './helpers.mjs';

const { KITS, KIT_REV, wrapKit, findBlock, kitStatuses, applyKitUpgrade } =
  await import('file://' + path.join(SCRIPTS, 'css-kit.mjs').replace(/\\/g, '/'));
const { TABLE_CSS } =
  await import('file://' + path.join(SCRIPTS, 'table-css.mjs').replace(/\\/g, '/'));

const initProj = () => {
  const p = tmpdir();
  const r = runSkill('init-project.mjs', [p, '--topic', 'T']);
  assert.equal(r.status, 0, r.stderr);
  return p;
};
const tokensOf = p => path.join(p, 'slides', 'tokens.css');
const read = p => fs.readFileSync(tokensOf(p), 'utf8');
const write = (p, css) => fs.writeFileSync(tokensOf(p), css);
// 把三个受管块的 rev 全部换成假值 = 模拟"源模块后来改了, 项目里还是旧 rev"
const withStaleRev = css => {
  let out = css;
  for (const k of KITS) {
    const b = findBlock(out, k.id);
    out = out.slice(0, b.start) + wrapKit(k.id, k.css, '0000deadbeef0000') + out.slice(b.end);
  }
  return out;
};

describe('受管块 · 单元', () => {
  test('KIT_REV 是内容哈希(64 位 hex), wrapKit/findBlock 可往返', () => {
    assert.match(KIT_REV, /^[0-9a-f]{64}$/);
    for (const k of KITS) {
      const wrapped = wrapKit(k.id, k.css);
      const b = findBlock(wrapped, k.id);
      assert.ok(b, `${k.id} 应能找回受管块`);
      assert.equal(b.rev, KIT_REV);
      assert.equal(b.body.trim(), k.css.trim());
      assert.equal(findBlock(`/* 无关 */\n.foo{}`, k.id), null);
    }
  });

  test('内容变了 rev 必须变(判定依据是内容, 不是"出现过没有")', () => {
    const r1 = applyKitUpgrade(`:root{}\n${KITS.map(k => wrapKit(k.id, k.css, 'a'.repeat(64))).join('\n')}\n`);
    assert.equal(r1.actions.length, 3, '假 rev 的块全部判旧');
    const mutated = KITS[2].css.replace('72px', '60px');
    const st = kitStatuses(`${wrapKit(KITS[2].id, mutated)}\n`);
    assert.equal(st[2].status, 'stale', '块内容与 rev 不符应判 stale(被手工改过)');
  });
});

describe('受管块 · 新项目直出', () => {
  test('init 生成的 tokens.css 带三个受管块, --check-css 绿', () => {
    const p = initProj();
    const css = read(p);
    for (const k of KITS) {
      const b = findBlock(css, k.id);
      assert.ok(b, `缺 ${k.id} 受管块`);
      assert.equal(b.rev, KIT_REV, `${k.id} rev 应为当前`);
    }
    assert.equal((css.match(/rev=[0-9a-f]{64}/g) ?? []).length, 3, 'rev 标记恰好三处(头部注释不携带 rev)');
    const r = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('受管块 · 块在但旧(旧判定的漏检区)', () => {
  test('块 rev 落后 → 原地替换: 行数不变、无重复、.bak 先落盘', () => {
    const p = initProj();
    const fresh = read(p);
    write(p, withStaleRev(fresh));
    const before = read(p);
    assert.notEqual(before, fresh);
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    const after = read(p);
    assert.equal(after, fresh, '按 rev 原地替换后应与最新模板逐字节一致');
    assert.equal(fs.readFileSync(tokensOf(p) + '.bak', 'utf8'), before, '写前必须先备份');
    assert.equal((after.match(/@property --pv/g) ?? []).length, 1, '不得出现重复块');
  });

  test('块被手工改坏(rev 没变) → --check-css 报 stale, 升级按源重写', () => {
    const p = initProj();
    const tampered = read(p).replace('.tbl tbody tr { height: 72px; }', '.tbl tbody tr { height: 60px; }');
    assert.notEqual(tampered, read(p), '前置: 确实改到了受管块内的规则');
    write(p, tampered);
    const chk = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(chk.status, 1, '块内容与 rev 不符必须被发现');
    assert.ok(chk.stderr.includes('手工改过'), chk.stderr);
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.ok(read(p).includes('.tbl tbody tr { height: 72px; }'), '升级后按技能当前源恢复');
  });

  test('用户覆写在受管块之后 → 升级不碰它(旧追加式会把它压掉)', () => {
    const p = initProj();
    const fresh = read(p);
    const override = '\n/* 项目端覆写: 行高按这台投影调过 */\n.tbl tbody tr { height: 96px; }\n';
    write(p, withStaleRev(fresh) + override);
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    const after = read(p);
    assert.ok(after.trimEnd().endsWith('.tbl tbody tr { height: 96px; }'), '覆写必须原样留在文件尾');
    assert.equal((after.match(/height: 96px/g) ?? []).length, 1, '覆写不得被复制或挪动');
    const b = findBlock(after, 'table');
    assert.ok(b.start < after.indexOf('height: 96px'), '受管块仍在覆写之前(覆写继续生效)');
  });

  test('旧判定核心缺陷不复存在: 升级过的项目在源模块再改后仍能继续升级(审计实验 D)', () => {
    const p = initProj();
    runSkill('init-project.mjs', [p, '--upgrade-css']);           // 第一次: 无需升级
    // 模拟源模块又改了: 把项目里的块回滚成"旧 rev + 旧内容"(少一条规则)
    let css = read(p);
    const k = KITS.find(x => x.id === 'chart');
    const b = findBlock(css, 'chart');
    const older = wrapKit('chart', k.css.replace(/\/\* 左侧刻度列[\s\S]*?padding-right: var\(--sp-2\); \}/, ''), '1111222233334444');
    css = css.slice(0, b.start) + older + css.slice(b.end);
    write(p, css);
    assert.ok(!read(p).includes('.chart-ticks'), '前置: .chart-ticks 已不在项目里');
    const chk = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(chk.status, 1, '旧 rev 必须报落后(旧实现此处报"无需升级")');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.ok(read(p).includes('.chart-ticks'), '源里的新规则必须传播进项目');
  });
});

describe('受管块 · 无定界的老文件迁移', () => {
  test('内容已是当前版(老 init 直出的裸文本) → check 绿, 升级原地包裹且与新模板逐字节一致', () => {
    const p = initProj();
    const fresh = read(p);
    // 老版 tokens.css 没有定界注释, 内容以裸文本插在模板里
    const legacy = fresh
      .replace(/\/\* >>> html2video:(?:nofx|chart|table) rev=[0-9a-f]{64} >>> \*\/\n/g, '')
      .replace(/\n\/\* <<< html2video:(?:nofx|chart|table) <<< \*\//g, '');
    assert.ok(!/>>> html2video:\w+ rev=/.test(legacy), '前置: 定界标记已全部去掉(头部注释里的示例文字无 rev, 不算)');
    write(p, legacy);
    const chk = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(chk.status, 0, '内容当前就该是 ok, 不该骚扰');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(read(p), fresh, '原地包裹后应回到与新模板完全一致');
  });

  test('裸文本重复两份(旧追加时代留的) → 包裹一次并清掉重复', () => {
    const p = initProj();
    const fresh = read(p);
    const legacy = fresh
      .replace(/\/\* >>> html2video:(?:nofx|chart|table) rev=[0-9a-f]{64} >>> \*\/\n/g, '')
      .replace(/\n\/\* <<< html2video:(?:nofx|chart|table) <<< \*\//g, '');
    const dup = legacy + '\n' + KITS[2].css + '\n';               // 表格原语被追加过第二份
    write(p, dup);
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    const after = read(p);
    assert.equal((after.match(/\.tbl \{[^}]*border-collapse/g) ?? []).length, 1, '重复的表格原语必须只剩一份');
    assert.equal((after.match(/>>> html2video:table/g) ?? []).length, 1);
  });

  test('完全缺失 → 文件尾追加三块; 原有内容在前; 幂等', () => {
    const p = mkproj(tmpdir());
    const r1 = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r1.status, 0, r1.stderr);
    const once = read(p);
    assert.ok(once.startsWith(':root { --accent: #111; }'), '原有内容必须在前');
    for (const k of KITS) assert.ok(findBlock(once, k.id), `缺 ${k.id} 受管块`);
    const r2 = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r2.status, 0);
    assert.equal(read(p), once, '第二次不得再追加');
    assert.ok(r2.stdout.includes('无需升级'));
  });

  test('旧版残留(内容与当前不同) → 追加当前块在旧规则之后(后写覆盖), 提示挪覆写', () => {
    // 探针规则(.tbl 行高/.kv)保持原样、其余内容是旧版 —— 探针通过但逐字不含当前版, 即"旧版残留"
    const oldTable = TABLE_CSS.replace(/\.rank td \{[^}]*\}/, m => m.replace('72px', '60px'));
    const p = mkproj(tmpdir(), { tokens: oldTable });
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('挪到受管块之后'), '必须提醒文件尾覆写会被压过');
    const css = read(p);
    assert.ok(css.lastIndexOf('height: 72px') > css.lastIndexOf('height: 60px'), '当前版必须排在旧规则之后(CSS 后写覆盖)');
  });
});

describe('--check-css CLI 语义', () => {
  test('落后 → 退出 1 并给出修复命令; 升级后 → 退出 0', () => {
    const p = mkproj(tmpdir());
    const bad = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes('--upgrade-css'), '要给出修复动作');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0);
  });
});
