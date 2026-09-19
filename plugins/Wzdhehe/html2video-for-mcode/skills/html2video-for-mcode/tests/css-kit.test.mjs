// CSS 工具箱受管块: "块在但内容旧"必须被发现并原地修复。
// 这是"改了 CSS 但项目里没生效"的根因回归 —— 2026-09-18 双代理审计定案: 旧判定只探
// 1–2 个标记字符串, 项目补过一次后就永远报"无需升级"(源模块后续改动永不传播);
// 追加式升级还会压掉项目端覆写并留下整份重复块。本文件逐条锁死这些行为。
//
// 2026-09-18 第二轮(整段受管化 + 三条静默路径): 生成物主体也进了受管区(`tokens`), 于是
// 判定多了 duplicate(同 id 多块 / 整份重复) / broken(开标记无配对收尾) / legacy-outside
// (受管区之外残留旧副本) 三个状态; 升级顺序也定死: 先落 tokens 区, 再清区外副本 ——
// 反过来的话, 裸文本主体里的工具箱原文会被当区外副本删掉, 于是 indexOf 失配 → 又多插一份、
// 旧主体还留在后面按层叠压过新版(本项目实测踩到, 见"整段受管化 · 顺序与层叠"用例)。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, mkproj, tmpdir, SCRIPTS, LEGACY_TOKENS } from './helpers.mjs';

const { KITS, KIT_REV, TOKENS_ID, wrapKit, wrapTokens, findAllBlocks, findBlock, outsideRegions,
  kitStatuses, tokensStatus, applyKitUpgrade, MAX_SCAN_BYTES } =
  await import('file://' + path.join(SCRIPTS, 'css-kit.mjs').replace(/\\/g, '/'));
const { TOKENS_REV, generateTokensCss } =
  await import('file://' + path.join(SCRIPTS, 'tokens-template.mjs').replace(/\\/g, '/'));
const { TABLE_CSS } =
  await import('file://' + path.join(SCRIPTS, 'table-css.mjs').replace(/\\/g, '/'));
const { NOFX_CSS } =
  await import('file://' + path.join(SCRIPTS, 'nofx-css.mjs').replace(/\\/g, '/'));
const { CHART_CSS } =
  await import('file://' + path.join(SCRIPTS, 'chart-css.mjs').replace(/\\/g, '/'));

const EXPECT = { text: generateTokensCss(), rev: TOKENS_REV };
const allStatus = css => kitStatuses(css, { expected: EXPECT });
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
// 老格式(老版 init 直出): 只有整段生成物外面没有 tokens 定界注释, **内嵌的 kit 子块照样带定界**
// (老模板把三个工具箱块放在主体里)。所以这里只抹掉 tokens 那一对, 不动 kit 的。
const stripTokensTag = css => css
  .replace(/\/\* >>> html2video:tokens rev=[0-9a-f]{8,64} >>> \*\/\n?/, '')
  .replace(/\/\* <<< html2video:tokens <<< \*\/\n?/, '');

describe('受管块 · 单元', () => {
  test('KIT_REV 是内容哈希(64 位 hex), wrapKit/findBlock 可往返', () => {
    assert.match(KIT_REV, /^[0-9a-f]{64}$/);
    assert.match(TOKENS_REV, /^[0-9a-f]{64}$/);
    for (const k of KITS) {
      const wrapped = wrapKit(k.id, k.css);
      const b = findBlock(wrapped, k.id);
      assert.ok(b, `${k.id} 应能找回受管块`);
      assert.equal(b.rev, KIT_REV);
      assert.equal(b.body.trim(), k.css.trim());
      assert.equal(findBlock(`/* 无关 */\n.foo{}`, k.id), null);
    }
    const t = findAllBlocks(wrapTokens(generateTokensCss(), TOKENS_REV), TOKENS_ID);
    assert.equal(t.length, 1);
    assert.equal(t[0].rev, TOKENS_REV);
    assert.equal(t[0].body.trim(), EXPECT.text.trim());
  });

  test('内容变了 rev 必须变(判定依据是内容, 不是"出现过没有")', () => {
    const r1 = applyKitUpgrade(`:root{}\n${KITS.map(k => wrapKit(k.id, k.css, 'a'.repeat(64))).join('\n')}\n`);
    assert.equal(r1.actions.filter(a => a.action === 'replaced').length, 3, '假 rev 的块全部判旧');
    const mutated = KITS[2].css.replace('72px', '60px');
    const st = kitStatuses(`${wrapKit(KITS[2].id, mutated)}\n`);
    assert.equal(st[2].status, 'stale', '块内容与 rev 不符应判 stale(被手工改过)');
  });
});

describe('受管块 · 新项目直出', () => {
  test('init 生成的 tokens.css 带 tokens 受管区(内含三个工具箱), --check-css 绿', () => {
    const p = initProj();
    const css = read(p);
    for (const k of KITS) {
      const b = findBlock(css, k.id);
      assert.ok(b, `缺 ${k.id} 受管块`);
      assert.equal(b.rev, KIT_REV, `${k.id} rev 应为当前`);
    }
    const t = findAllBlocks(css, TOKENS_ID);
    assert.equal(t.length, 1, 'tokens 受管区恰好一个');
    assert.equal(t[0].rev, TOKENS_REV, 'tokens 区 rev 应为当前');
    assert.equal(t[0].body.trim(), EXPECT.text.trim(), 'tokens 区内容应与当前模板逐字节一致');
    assert.equal((css.match(/rev=[0-9a-f]{64}/g) ?? []).length, 4, 'rev 标记恰好四处(tokens + 三个工具箱; 头部注释不携带 rev)');
    assert.ok(allStatus(css).every(s => s.status === 'ok'), JSON.stringify(allStatus(css).map(s => s.id + ':' + s.status)));
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
    const legacy = stripTokensTag(fresh);
    assert.ok(!/>>> html2video:tokens rev=/.test(legacy), '前置: tokens 定界已去掉(头部注释里的示例文字无 rev, 不算)');
    assert.ok(/>>> html2video:nofx rev=/.test(legacy), '前置: 内嵌的 kit 子块照旧留着(老格式就是这样)');
    write(p, legacy);
    const chk = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(chk.status, 0, '内容当前就该是 ok, 不该骚扰');
    assert.ok((chk.stdout + chk.stderr).includes('老格式'), '要说明是靠裸文本内容判定的');
    const st = tokensStatus(legacy, EXPECT);
    assert.equal(st.status, 'ok', JSON.stringify(st));
    assert.ok(st.detail.includes('无受管区'), st.detail);
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(read(p), fresh, '原地包裹后应回到与新模板完全一致');
  });

  test('裸文本重复两份(旧追加时代留的) → check 报错并归并为一', () => {
    const p = initProj();
    const fresh = read(p);
    const legacy = stripTokensTag(fresh);
    // (a) 整份生成物出现两次 → tokens 判 duplicate
    const dup = legacy + '\n' + EXPECT.text.trim() + '\n';
    write(p, dup);
    assert.equal(tokensStatus(dup, EXPECT).status, 'duplicate', '整份生成物出现两次必须报出来');
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 1, '重复的生成物不许静默通过');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(findAllBlocks(read(p), TOKENS_ID).length, 1, '归并后只剩一个 tokens 区');
    assert.equal((read(p).match(/>>> html2video:table/g) ?? []).length, 1);
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0);
    // (b) 只有某个工具箱被追加过第二份(无定界的裸副本) → 该 kit 判 legacy-outside
    write(p, legacy + '\n' + KITS[2].css + '\n');
    assert.equal(kitStatuses(read(p), { expected: EXPECT }).find(s => s.id === 'table').status, 'legacy-outside');
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 1, '区外多一份表格原语同样不许通过');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    const after = read(p);
    assert.equal((after.match(/\.tbl \{[^}]*border-collapse/g) ?? []).length, 1, '重复的表格原语必须只剩一份');
    assert.equal((after.match(/>>> html2video:table/g) ?? []).length, 1);
  });

  test('完全缺失 → 文件尾追加受管区; 原有内容在前; 幂等', () => {
    const p = mkproj(tmpdir());
    const r1 = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r1.status, 0, r1.stderr);
    const once = read(p);
    assert.ok(once.startsWith(':root { --accent: #111; }'), '原有内容必须在前');
    for (const k of KITS) assert.ok(findBlock(once, k.id), `缺 ${k.id} 受管块`);
    assert.ok(findBlock(once, TOKENS_ID), '缺 tokens 受管区');
    assert.ok(once.indexOf(TOKENS_ID) > once.indexOf('--accent: #111'), '受管区必须排在原有内容之后(后写才压得住旧值)');
    const r2 = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r2.status, 0);
    assert.equal(read(p), once, '第二次不得再追加');
    assert.ok(r2.stdout.includes('无需升级'));
  });

  test('旧版残留(整份旧副本) → 已落入层叠死区: 升级清掉副本、当前版进受管区、可重复升级', () => {
    // 探针规则(.tbl 行高/.kv)保持原样、其余内容是旧版 —— 探针通过但逐字不含当前版, 即"旧版残留"
    const oldTable = TABLE_CSS.replace(/\.rank td \{[^}]*\}/, m => m.replace('72px', '60px'));
    const p = mkproj(tmpdir(), { tokens: oldTable });
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    const css = read(p);
    // 旧实现是"把当前版追加到旧规则之后靠后写覆盖": 一旦旧副本又被写回文件尾就又落后了。
    // 现在整份旧副本按 kind='copy' 直接清掉(原件在 .bak), 所以文件里只剩当前版一条。
    assert.equal((css.match(/\.rank td \{[^}]*\}/g) ?? []).length, 1, '旧副本必须被清掉, 当前版只剩一条');
    assert.ok(css.includes('72px'), '内容应是当前版(72px)');
    assert.ok(!/height: 60px/.test(css), '旧值(60px)不得残留');
    assert.ok(css.trimEnd().endsWith('<<< */'), '受管区必须落在文件末尾(层叠上后写才压得住前面的旧内容)');
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0, '升级后必须绿');
    assert.ok(r.stdout.includes('清理') || r.stdout.includes('受管区'), r.stdout);
  });
});

describe('受管块 · 整段受管化(2026-09-18 补: 四条静默路径的逐个回归)', () => {
  test('主体陈旧 → tokens 区被整体就地替换, 区外的项目规则一字不动', () => {
    const body = generateTokensCss().replace('--fs-h1: 64px', '--fs-h1: 60px');   // 模拟旧版主体
    assert.notEqual(body, generateTokensCss(), '前置: 造出了与当前不同的主体内容');
    assert.ok(!body.includes('--fs-h1: 64px'), '前置: 旧值确实换掉了');
    const css = `${wrapTokens(body, 'cafebabecafebabe')}\n.proj { color: blue }\n`;
    const st = tokensStatus(css, EXPECT);
    assert.equal(st.status, 'stale', JSON.stringify(st));
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css;
    assert.equal(findAllBlocks(up, TOKENS_ID).length, 1);
    assert.equal(findAllBlocks(up, TOKENS_ID)[0].body.trim(), EXPECT.text.trim(), '整段应换成当前版');
    assert.ok(!up.includes('--fs-h1: 60px'), '旧主体的值不得残留');
    assert.ok(up.includes('.proj { color: blue }'), '区外的项目规则必须保留');
    assert.equal(allStatus(up).find(s => s.id === TOKENS_ID).status, 'ok');
  });

  test('同一 id 两个块 → 报 duplicate, 升级归并为一(块外那份按层叠会赢)', () => {
    const one = wrapKit('table', TABLE_CSS, 'a'.repeat(16));
    const two = wrapKit('table', TABLE_CSS.replace('72px', '60px'), 'b'.repeat(16));
    const css = `${one}\n${two}\n`;
    const st = kitStatuses(css);
    assert.equal(st[2].status, 'duplicate', JSON.stringify(st.map(s => s.id + ':' + s.status)));
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css;
    assert.equal(findAllBlocks(up, 'table').length, 1, '归并为一');
    assert.equal(findAllBlocks(up, 'table')[0].body.trim(), TABLE_CSS.trim(), '留下的是当前版');
    assert.equal((up.match(/height: 60px/g) ?? []).length, 0, '块外那份旧副本必须清掉');
  });

  test('开标记无配对收尾 → 报 broken(旧实现因字符串命中反而报 ok), 升级后不得叠加第二个开标记', () => {
    const css = `${wrapKit('nofx', NOFX_CSS, 'a'.repeat(16))}\n/* >>> html2video:table rev=b4c5d6e7 >>> */\n.tbl { color: red }\n`;
    const st = kitStatuses(css);
    assert.equal(st[2].status, 'broken', JSON.stringify(st.map(s => s.id + ':' + s.status)));
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css;
    const opens = up.match(/>>> html2video:table rev=/g) ?? [];
    assert.equal(opens.length, findAllBlocks(up, 'table').length, '开标记数必须与配对块数一致');
    assert.equal(opens.length, 1);
    assert.ok(up.includes('.tbl { color: red }'), '用户自己写的规则保留');
  });

  test('受管区之外残留旧副本 → 报 legacy-outside; 升级清副本但保留用户单条覆写', () => {
    const override = '.tbl tbody tr { height: 96px; }';
    // tokens 区里本来就含一份当前的 table 子块, 区外这份是旧副本(后出现 → 按层叠会赢)
    const css = `${wrapTokens(generateTokensCss(), TOKENS_REV)}\n${TABLE_CSS}\n${override}\n`;
    const st = kitStatuses(css, { expected: EXPECT });
    const table = st.find(s => s.id === 'table');
    assert.equal(table.status, 'legacy-outside', st.map(s => s.id + ':' + s.status).join(' '));
    assert.ok(table.detail.includes('受管区之外'), table.detail);
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV });
    const actions = up.actions.map(a => a.action);
    assert.ok(actions.includes('removed-legacy-outside'), actions.join(','));
    assert.ok(actions.includes('kept-legacy-overrides'), '紧邻旧副本的用户覆写必须被单独保留: ' + actions.join(','));
    assert.equal(findAllBlocks(up.css, 'table').length, 1);
    assert.equal((up.css.match(/\.tbl tbody tr \{ height: 72px; \}/g) ?? []).length, 1, '受管区里的当前版只剩一条');
    assert.ok(up.css.includes(override), '用户单条覆写必须原样保留(区外规则一概不动)');
    assert.ok(allStatus(up.css).every(s => s.status === 'ok'), allStatus(up.css).map(s => s.id + ':' + s.status).join(' '));
  });

  test('区外整份旧副本被改过几处(不止一处) → 整段清掉: 它是压在受管区上的错误产物', () => {
    const modCopy = TABLE_CSS.replace('72px', '60px');
    const override = '.tbl tbody tr { height: 96px; }';
    const css = `${wrapTokens(generateTokensCss(), TOKENS_REV)}\n${modCopy}\n${override}\n`;
    assert.equal(kitStatuses(css, { expected: EXPECT }).find(s => s.id === 'table').status, 'legacy-outside');
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css;
    assert.ok(!/height: 60px/.test(up), '被改过的整份旧副本必须清掉(否则它会按层叠压过受管区)');
    assert.ok(up.includes(override), '与之相邻的用户覆写仍然保留');
    assert.equal(allStatus(up).every(s => s.status === 'ok'), true, allStatus(up).map(s => s.id + ':' + s.status).join(' '));
  });

  test('老格式裸文本 + 旧主体并存 → 生成物排在旧内容之后(层叠上后写才生效), 且幂等', () => {
    // 顺序回归: 升级必须"先判是否已有当前版主体、再剥内嵌子块"。反过来的话裸文本主体里的工具箱原文
    // 会被当区外副本删掉 → indexOf 失配 → 插到文件末尾之外的位置 + 旧主体留在后面压过新版(实测踩到过)。
    const oldBody = generateTokensCss().replace('--fs-h1: 64px', '--fs-h1: 60px');
    const css = `/* 老项目 */\n${oldBody}\n.proj { color: blue }\n`;
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css;
    assert.equal((up.match(/>>> html2video:tokens/g) ?? []).length, 1, '只能有一个受管区(不得多插一份)');
    assert.ok(up.indexOf('>>> html2video:tokens') > up.indexOf('--fs-h1: 60px'), '受管区必须在旧主体之后(否则旧值压过新版)');
    assert.ok(up.includes('.proj { color: blue }'), '项目规则保留');
    for (const k of KITS) assert.equal(findAllBlocks(up, k.id).length, 1, `${k.id} 恰好一个受管块`);
    assert.equal(applyKitUpgrade(up, { tokensText: EXPECT.text, tokensRev: TOKENS_REV }).css, up, '幂等');
    // 逐字与当前版相同的旧主体规则会被清掉; 与当前版**不同**的那条留下并如实报出来
    // (工具分不出"旧残留"还是"你有意改的", 所以报出来由人决定 —— 复查 A7 定下的语义)
    const st = allStatus(up);
    const tokens = st.find(s => s.id === TOKENS_ID);
    assert.equal(tokens.status, 'legacy-outside', st.map(s => s.id + ':' + s.status).join(' '));
    assert.match(tokens.detail, /与当前版不同|逐字相同/, tokens.detail);
    assert.ok(st.filter(s => s.id !== TOKENS_ID).every(s => s.status === 'ok'), st.map(s => s.id + ':' + s.status).join(' '));
    // 关键的用户可见结论: 与当前版不同的那条旧规则虽然留着(工具分不出来是不是有意改的),
    // 但它在受管区**之前**, 所以渲染用的是受管区里的当前值 —— 这就是"区域排在最后"的意义
    assert.equal(up.split('--fs-h1: 60px').length - 1, 1, '与当前版不同的那条只应留一条(其余逐字相同的旧规则都该被清掉)');
    assert.ok(up.includes('--fs-h1: 64px'), '受管区里应有当前值');
    assert.ok(up.indexOf('--fs-h1: 64px') > up.indexOf('--fs-h1: 60px'), '当前值必须出现在旧值之后(层叠上生效)');
  });

  test('区外扫描的可见范围: outsideRegions 把受管区(含内部工具箱子块)整体挖掉', () => {
    const css = `${wrapTokens(generateTokensCss(), TOKENS_REV)}\n.keepme { color: red }\n`;
    const out = outsideRegions(css);
    assert.ok(out.includes('.keepme'), '区外内容应保留在视野里(嵌套区间的掩码不许吃掉它)');
    assert.equal(out.length, css.length, '掩码与原文等长, 偏移才对得回原文');
    assert.ok(!out.includes('.no-fx'), 'tokens 区内的工具箱内容不得计入区外');
    assert.ok(!out.includes('.chart-bar'), 'tokens 区内的图表工具内容不得计入区外');
  });
});

describe('--check-css CLI 语义', () => {
  test('落后 → 退出 1 并给出修复命令; 升级后 → 退出 0', () => {
    const p = mkproj(tmpdir(), { tokens: LEGACY_TOKENS });
    const bad = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(bad.status, 1);
    assert.ok(bad.stderr.includes('--upgrade-css'), '要给出修复动作');
    runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0);
  });
});

describe('受管块 · 行尾与病态输入(2026-09-18 三维审计补的回归)', () => {
  test('CRLF 文件(git autocrlf 检出)不误报: check 绿; 升级后受管块统一为 LF 并如实说明', () => {
    const p = initProj();
    const fresh = read(p);
    write(p, fresh.replace(/\n/g, '\r\n'));
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0, '只换了行尾, 不该判"被手工改过"');
    write(p, withStaleRev(read(p)).replace(/\n/g, '\r\n'));   // 行尾 + 旧 rev 一起, 走真升级路径
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('行尾已统一为 LF'), r.stdout);
    assert.ok(!findBlock(read(p), 'chart').body.includes('\r'), '受管块内不得再残留 CRLF');
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0);
  });

  test('.bak 已存在 → 显式警告后再覆盖(旧备份无声丢是不对的)', () => {
    const p = initProj();
    const stale = withStaleRev(read(p));
    write(p, stale);
    fs.writeFileSync(tokensOf(p) + '.bak', 'OLD PRECIOUS BACKUP');
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok((r.stdout + r.stderr).includes('将被本次升级前的备份覆盖'), '必须警告');
    assert.ok(fs.readFileSync(tokensOf(p) + '.bak', 'utf8').includes('0000dead'), '.bak 应是升级前的内容');
  });

  test('病态互踩: nofx 裸文本嵌在 chart 旧受管块内 → 一次升级全部到位(不再"上次成功这次又落后")', () => {
    const hostile = `:root{--a:1}\n${wrapKit('chart', CHART_CSS + '\n' + NOFX_CSS, 'a'.repeat(64))}\n`;
    const p = mkproj(tmpdir(), { tokens: hostile });
    const r = runSkill('init-project.mjs', [p, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(runSkill('init-project.mjs', [p, '--check-css']).status, 0, '一次升级后三段必须全部就位');
    for (const k of KITS) assert.ok(findBlock(read(p), k.id), `缺 ${k.id} 受管块`);
  });

  test('超大 tokens.css → 拒绝扫描(构造输入会让受管块定位二次方变慢, 4MB 实测 39s)', () => {
    const p = mkproj(tmpdir(), { tokens: '/* >>> html2video:nofx rev=aaaaaaaa >>> */\n' + '/* '.repeat(MAX_SCAN_BYTES / 3 + 10) });
    const r = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(r.status, 1);
    assert.ok((r.stdout + r.stderr).includes('拒绝扫描'), '要说明是拒绝扫描而不是慢慢算');
  });
});

describe('陈旧 CSS 闸门(2026-09-18 复查: 陈旧必须阻断, 不许静默出旧画面)', () => {
  const slideHtml = `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">标题</h1></div></body></html>`;
  const staleProj = () => {
    const p = mkproj(tmpdir(), { tokens: LEGACY_TOKENS, slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses: [{ stage: 1, text: '一句。' }] }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), slideHtml);
    return p;
  };

  test('capture: 受管块落后 → 退出 1 并给修复命令; --allow-stale-css 显式放行', () => {
    const p = staleProj();
    const r = runSkill('capture.mjs', [p]);
    assert.equal(r.status, 1, '旧 CSS 会照常出图且全程不报错 —— 必须在入口停住');
    assert.ok(r.stderr.includes('受管块与技能当前版不一致'), r.stderr.slice(-300));
    assert.ok(r.stderr.includes('--upgrade-css'), '要把修复命令给到手上');
    assert.ok(r.stderr.includes(p), '命令里要有本项目路径(可直接粘)');
    const r2 = runSkill('capture.mjs', [p, '--allow-stale-css']);
    assert.ok(r2.stderr.includes('已显式跳过闸门'), '显式跳过要留痕, 实际: ' + r2.stderr.slice(-200));
  });

  test('build-video: 同一道闸门(成片比预览图更贵, 更不能静默用旧 CSS)', () => {
    const p = staleProj();
    const r = runSkill('build-video.mjs', [p]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('build-video') && r.stderr.includes('受管块与技能当前版不一致'), r.stderr.slice(-300));
    assert.ok(r.stderr.includes('--allow-stale-css'));
  });

  test('check-slides: 受管块落后从"提示"升为"错误"级(阻断截图), 升级后恢复绿', () => {
    const p = staleProj();
    const r = runSkill('check-slides.mjs', [p]);
    assert.equal(r.status, 1, '提示级不得再放行陈旧 CSS');
    assert.ok(r.stdout.includes('✗ tokens.css'), r.stdout.slice(-400));
    assert.ok(r.stdout.includes('--upgrade-css'), '报错里要给修复命令');
    assert.equal(runSkill('init-project.mjs', [p, '--upgrade-css']).status, 0);
    assert.equal(runSkill('check-slides.mjs', [p]).status, 0, '升级后必须恢复');
  });

  test('真项目形状(项目规则 + 当前受管区) → 三个入口都不拦, 且把"区外覆写"作为提示打出来', () => {
    const p = mkproj(tmpdir(), { slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses: [{ stage: 1, text: '一句。' }] }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), slideHtml);
    fs.appendFileSync(path.join(p, 'slides', 'tokens.css'), '\n.tbl tbody tr { height: 96px; }\n');
    assert.notEqual(runSkill('check-slides.mjs', [p]).status, 1, '区外单条覆写不该让截图停摆');
    const r = runSkill('init-project.mjs', [p, '--check-css']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('覆写'), '要告诉用户区外有他自己的覆写: ' + r.stdout);
  });
});

describe('复查 A6/A7: "check 绿但画面是旧值"的最后两条路径(2026-09-18 第三轮 review 实测)', () => {
  test('A7: 受管区之后粘着一段旧主体 → 必须报 legacy-outside(旧实现报"已是最新")', () => {
    // 旧实现只扫"工具箱选择器"与"逐字重复的整份主体", 于是这种布局被判 ok, 而那段旧规则
    // 按层叠压过受管区 —— 实测画面用的是 --fs-h1: 60px, check 却报 ✓ 已是最新。
    const oldFragment = generateTokensCss().replace('--fs-h1: 64px', '--fs-h1: 60px').slice(0, 4000);
    const css = `${wrapTokens(generateTokensCss(), TOKENS_REV)}\n\n/* 旧版残留(手粘) */\n${oldFragment}\n`;
    const st = tokensStatus(css, EXPECT);
    assert.equal(st.status, 'legacy-outside', JSON.stringify(st));
    assert.match(st.detail, /主体规则/, st.detail);
    assert.match(st.detail, /逐字相同/, '要说清升级会清掉哪一部分');
    // 升级: 逐字命中当前版的旧规则被清掉; 改过的那条留着并再次如实报出来(工具分不出旧残留与有意覆写)
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV });
    assert.equal(up.actions.filter(a => a.action === 'removed-legacy-outside').length, 1, up.actions.map(a => a.action).join(','));
    assert.equal(tokensStatus(up.css, EXPECT).status, 'legacy-outside', '改过的那条还在, 仍要报(由人决定)');
    assert.ok(up.actions.some(a => a.action === 'kept-legacy-overrides' && /与当前版不同/.test(a.reason)), up.actions.map(a => a.action).join(','));
  });

  test('A6: 老格式 + 文件尾的项目覆写 → 升级后必须说清它被受管区覆盖了(旧文案谎称"后出现者优先")', () => {
    const oldBody = generateTokensCss().replace('--fs-h1: 64px', '--fs-h1: 60px');
    const css = `/* 老项目 */\n${oldBody}\n:root { --accent: #D92B2B; }\n`;
    const up = applyKitUpgrade(css, { tokensText: EXPECT.text, tokensRev: TOKENS_REV });
    const regionAt = up.css.indexOf('>>> html2video:tokens');
    const overrideAt = up.css.indexOf('--accent: #D92B2B');
    assert.ok(overrideAt > -1 && overrideAt < regionAt, '前置: 老格式升级会把覆写留在受管区之前');
    const st = tokensStatus(up.css, EXPECT);
    assert.notEqual(st.status, 'ok', '这条改过的旧规则会一直被报出来, 由人决定: ' + JSON.stringify(st));
    assert.match(st.detail, /受管区\*\*之前\*\*/, '必须在状态里点名"会被受管区覆盖"(旧文案笼统写"后出现者优先", 与实际布局相反): ' + st.detail);
    assert.ok(/挪到受管区之后/.test(st.detail), '并给出可执行的做法: ' + st.detail);
  });
});
