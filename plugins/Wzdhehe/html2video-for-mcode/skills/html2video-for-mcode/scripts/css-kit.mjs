// html2video-for-mcode · CSS 工具箱的受管块机制(单一来源 → 项目 tokens.css 的可检测传播)。
//
// 演进史(每次都是实测踩出来的):
// 2026-09-18 一轮: 旧 --upgrade-css 用"存在性探针"判定, 项目补过一次就永远报"无需升级"; 追加式升级
//   压掉项目覆写并留重复段 → 改成"定界块 + 内容 rev + 原位替换"。
// 2026-09-18 二轮(外部评审 + 复查实测): 机制仍有三条"报 OK 却仍用旧 CSS"的静默路径 ——
//   ① 同一 kit 出现两个块、后一个陈旧: 旧实现只用 exec(非 g)看**第一个**块, 替换也换第一个,
//      块后的陈旧副本按层叠继续生效;
//   ② 块**之外**残留一份陈旧副本(旧版追加升级/手粘留下的): 全文件 never 被扫, 直接报"无需升级";
//   ③ 收尾定界符被改坏: BLOCK_RE 认不出块, 退到 `src.includes(整段 CSS)` 判定 → 报 ok,
//      升级还会再吐一个开标记。
//   三条都源自同一个设计缺口: **判定只看"我认得的那块", 不看"文件里还有没有别的副本"**。
// 本版据此重写:
//   · 定位改为 findAllBlocks(全局), 同 id 多块 → 一律判 duplicate 并在升级时归并为一;
//   · 判定加"受管块之外"扫描: 块外命中工具箱原文/承重规则 → legacy-outside(留档并清理原文副本);
//   · 开标记没有配对收尾 → broken(不再因为内容字符串命中就算 ok);
//   · 整个生成物(模板主体 + 三个工具箱子块)包进**一个 tokens 受管区**: 主体改动同样可检测、可原地
//     替换 —— 项目自己的规则写在 tokens 区之后, 升级一概不动(2026-09-18 用户决定: 旧产物不复用,
//     所以整段受管化优于"只检测不替换")。
//
// 边界: 受管区之内的一切由技能负责, 区之外一律不碰。项目若在区内改过内容, 升级会覆盖(会在 actions 里说明)。

import { createHash } from 'node:crypto';
import { NOFX_CSS, hasNofxRules } from './nofx-css.mjs';
import { CHART_CSS, hasChartKit } from './chart-css.mjs';
import { TABLE_CSS, hasTableKit } from './table-css.mjs';

// 扫描上限的单一来源在 limits.mjs(它对 tokens.css 与 slide HTML 都生效, 不该住在这个 CSS 模块里);
// 这里再导出一次只为保持既有调用点的 import 路径不变。
export { MAX_SCAN_BYTES } from './limits.mjs';

export const KITS = [
  { id: 'nofx', label: 'no-fx 规则', css: NOFX_CSS, probe: hasNofxRules, sig: /\.no-fx\b/ },
  { id: 'chart', label: '图表工具箱', css: CHART_CSS, probe: hasChartKit, sig: /\.(chart-|chart\b)/ },
  { id: 'table', label: '表格原语', css: TABLE_CSS, probe: hasTableKit, sig: /\.(tbl|matrix|rank|kv)\b/ },
];

// 整段受管区的 id: 包住模板主体(主题/字号/fx 工具类)+ 内部三个工具箱子块
export const TOKENS_ID = 'tokens';

/** 所有受管块 id(单一来源): 判定/升级/测试的正则与循环都从这里取, 加一个工具箱不用改五处 */
export const BLOCK_IDS = [TOKENS_ID, ...KITS.map(k => k.id)];


// rev 对"块里实际会写进项目的 CSS"求哈希: 三个模块的文本逐字决定 rev。
export const KIT_REV = createHash('sha256')
  .update(KITS.map(k => k.css).join('\n').replace(/\r\n/g, '\n'))
  .digest('hex');

export const openTag = (id, rev = KIT_REV) => `/* >>> html2video:${id} rev=${rev} >>> */`;
export const closeTag = id => `/* <<< html2video:${id} <<< */`;
export function wrapKit(id, css, rev = KIT_REV) {
  return `${openTag(id, rev)}\n${String(css).trim()}\n${closeTag(id)}`;
}
/** 把整段生成的 tokens.css 包进受管区(内部照旧含三个工具箱子块) */
export function wrapTokens(text, rev) {
  return `${openTag(TOKENS_ID, rev)}\n${String(text).trim()}\n${closeTag(TOKENS_ID)}`;
}

const BLOCK_RE_G = id => new RegExp(
  `/\\* >>> html2video:${id} rev=([0-9a-f]{8,64}) >>> \\*/([\\s\\S]*?)/\\* <<< html2video:${id} <<< \\*/`, 'g');
const OPEN_RE_G = id => new RegExp(`/\\* >>> html2video:${id} rev=([0-9a-f]{8,64}) >>> \\*/`, 'g');

/** 所有配对完整的受管块: [{ start, end, rev, body }] —— 用全局匹配, 不再只看第一个 */
export function findAllBlocks(css, id) {
  const src = String(css ?? '');
  const out = [];
  for (const m of src.matchAll(BLOCK_RE_G(id))) {
    out.push({ start: m.index, end: m.index + m[0].length, rev: m[1], body: m[2] });
  }
  return out;
}

/** 第一个受管块(兼容旧调用) */
export function findBlock(css, id) {
  return findAllBlocks(css, id)[0] ?? null;
}

/** 开标记总数(含没有配对收尾的孤儿): 用来发现"定界符被改坏" */
export function countOpenTags(css, id) {
  return [...String(css ?? '').matchAll(OPEN_RE_G(id))].length;
}

// ── 受管区间的取法 ───────────────────────────────────────────────
// 老格式的主体里**嵌着**三个工具箱子块(新版是 tokens 区套住它们), 所以区间天然会嵌套/相交。
// 第一版拿"按 start 降序逐个裁掉"的写法处理, 嵌套时外层区间的 end 已经被内层删除顶偏了 ——
// 实测 `outsideRegions` 会把受管区之后的项目规则一起吃掉(out.len 只剩 1 个字符)。
// 所以统一走"区间并集 + 等长掩码": 一次成型的空格掩码, 偏移照旧对得回原文。
function regionRanges(src) {
  const raw = [
    ...findAllBlocks(src, TOKENS_ID).map(b => [b.start, b.end]),
    ...KITS.flatMap(k => findAllBlocks(src, k.id)).map(b => [b.start, b.end]),
  ].sort((a, b) => a[0] - b[0]);
  const union = [];
  for (const [s, e] of raw) {
    const last = union[union.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else union.push([s, e]);
  }
  return union;
}
function maskedAll(src, ranges) {
  let masked = '', cursor = 0;
  for (const [s, e] of ranges) { masked += src.slice(cursor, s) + ' '.repeat(e - s); cursor = e; }
  return masked + src.slice(cursor);
}

/** 受管区之外的文本(等长掩码, 区内一律变空格; 判定"块外是否还有残留副本"用) */
export function outsideRegions(css) {
  const src = String(css ?? '').replace(/\r\n/g, '\n');
  return maskedAll(src, regionRanges(src));
}

// ── 区外残留副本的定位 ───────────────────────────────────────────
// 光比"整段原文"不够: 旧版追加升级/手粘的副本常被改过一两处(比如行高 72→60), 原文比对失配,
// 但它在层叠上**后出现就赢** —— 于是判定必须按选择器找"区外还有属于我们的规则":
//   · 工具箱规则: 按选择器签名(.no-fx / .chart-* / .tbl·.matrix·.rank·.kv)归到对应 kit;
//   · **主体规则**(2026-09-18 复查 A7 补): 选择器出现在当前生成物里的规则(如 :root / .fx-* /
//     [data-stage] / .stage)归到 TOKENS_ID —— 否则"受管区后面粘着一段旧主体"这种布局会被判 ok,
//     而那段旧规则按层叠压过受管区(实测: --check-css 报"已是最新", 画面用的是 --fs-h1: 60px)。
//     A7 这类片段必然"与当前版不同"(否则它就是当前版), 所以主体段不能像工具箱那样要求逐字命中,
//     改按体量判: ≥400 字符或 ≥3 条 → 作为残留报出来(报而不删, 由人决定它是旧残留还是有意覆写)。
export function legacyOutsideBlocks(css, { bodyText = null } = {}) {
  const src = String(css ?? '').replace(/\r\n/g, '\n');
  // 掩码必须与 src **等长**, 否则算出的偏移对不回原文(第一版就错在这里: 拿 outsideRegions 的
  // 结果当底, 长度已经变短, 于是位置全偏、一条也扫不出来)。
  const masked = maskedAll(src, regionRanges(src));
  const body = bodyText ? String(bodyText).replace(/\r\n/g, '\n') : null;
  const bodyNorm = body ? body.replace(/\s+/g, ' ') : null;
  const inBody = sel => {
    if (!bodyNorm) return false;
    const s = sel.replace(/\s+/g, ' ').trim();
    return s.length > 0 && s.length < 400 && bodyNorm.includes(s);
  };
  // 区外**所有**规则体(选择器 + 花括号配对的那一段), 再按归属筛
  const findRuleEnd = from => {
    let depth = 0;
    for (let i = from; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') { depth--; if (depth === 0) return i + 1; }
    }
    return -1;
  };
  const out = [];
  let acceptedEnd = -1;                       // 已收下的规则覆盖到哪 —— 跳过它内部的嵌套 `{`
  for (const m of masked.matchAll(/[^\n{};]*\{/g)) {
    if (m.index < acceptedEnd) continue;      // @keyframes 里的 from{}/to{} 不再算一条: 两条片段重叠时
                                              // 按偏移删除会错位, 连带把后面的受管区删掉(实测踩到过)
    const end = findRuleEnd(m.index + m[0].length - 1);
    if (end < 0) continue;
    const sel = m[0].slice(0, -1);
    const kit = KITS.find(k => k.sig.test(sel));
    const id = kit ? kit.id : inBody(sel) ? TOKENS_ID : null;
    if (!id) continue;                       // 不是我们的规则(用户自己的选择器) → 不归我们管
    const label = kit ? kit.label : 'tokens 主体(主题/字号/fx/工具箱)';
    out.push({ id, label, start: m.index, end, text: src.slice(m.index, end) });
    acceptedEnd = end;
  }
  // 同一归属的相邻规则合并成一段 —— "相邻"要允许**注释**夹在中间(模块原文的规则之间就有
  // 段落注释; 只认空白的话, 一份整旧副本会被拆成七八段, 单条的那些反而被判成"用户覆写"留着,
  // 继续按层叠压过受管区 —— 实测踩到过)。合并后按整段长度/条数才判得准; 每段带上 rules,
  // 清理时按条判定(逐字来自模块原文的才删)。
  const COMMENT_GAP = /^(?:\s|\/\*[\s\S]*?\*\/)*$/;
  out.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && last.id === b.id && COMMENT_GAP.test(src.slice(last.end, b.start))) {
      last.end = b.end; last.text = src.slice(last.start, b.end);
      last.rules.push({ start: b.start, end: b.end, text: b.text });
    } else merged.push({ ...b, rules: [{ start: b.start, end: b.end, text: b.text }] });
  }
  // 分类: 大段/多规则 **且含原文的规则** = 旧版整份副本(升级清理);
  // 单条小规则、或一条原文都不含的多条规则(自己写的样式段) = 覆写(保留, 只提示)。
  // 加"含原文"这一条是因为: 光看长度会把"用户自己写的三条长规则"当副本删掉 ——
  // 而一份真副本(哪怕被改过一两处)必然含有多条逐字相同的原文规则。
  // 主体段(TOKENS_ID)例外: 按体量判 copy(见上面的说明), 但删除照旧只删逐字命中当前版的规则。
  const norm = s => s.replace(/\s+/g, ' ');
  const refOf = b => norm(b.id === TOKENS_ID ? String(bodyText ?? '') : KITS.find(k => k.id === b.id).css);
  return merged.map(b => {
    const mod = refOf(b);
    const verbatim = b.rules.filter(r => mod.includes(norm(r.text).trim())).length;
    const big = b.text.length >= 400 || b.rules.length >= 3;
    const looksLikeCopy = verbatim >= 2 || verbatim / b.rules.length >= 0.5;
    const kind = b.id === TOKENS_ID ? (big ? 'copy' : 'override') : (big && looksLikeCopy ? 'copy' : 'override');
    return { ...b, verbatim, kind };
  });
}

// ── 状态判定 ─────────────────────────────────────────────────────
// 每个工具箱(以及整段 tokens 区)的状态:
//   ok              受管块存在、rev 与内容都与技能当前一致
//   stale           受管块存在但 rev 落后或内容被改过 → 升级时原地替换
//   duplicate       同一 id 有多个受管块 → 升级时归并为一(块外的旧副本按层叠会赢, 必须报出来)
//   broken          开标记没有配对收尾(定界符被改坏) → 升级时清掉孤儿标记并重建
//   legacy-outside  受管块之外还留着同一份内容的副本 → 升级时删掉副本
//   missing         既无受管块也无当前内容
export function kitStatuses(css, { rev = KIT_REV, expected = null } = {}) {
  const src = String(css ?? '').replace(/\r\n/g, '\n');   // 行尾归一: rev 是按 LF 算的(git autocrlf 检出会带 CRLF)
  const legacyBlocks = legacyOutsideBlocks(src, { bodyText: expected?.text ?? null });   // 区外的同类规则(含被改过的副本)
  // 覆写在受管区之前还是之后, 决定了它到底压不压得住受管区 —— 复查 A6 实测: 老格式文件升级时
  // 生成物被追加到**文件末尾**, 原来在文件尾的项目覆写就变成"在受管区之前", 于是反被覆盖。
  // 位置算得出来, 就别再笼统写"后出现者优先"(那句话在 A6 布局下是假的)。
  const regionStart = findAllBlocks(src, TOKENS_ID)[0]?.start ?? Number.POSITIVE_INFINITY;
  const overrideNote = (list, label) => {
    const before = list.filter(b => b.start < regionStart).reduce((a, b) => a + b.rules.length, 0);
    const total = list.reduce((a, b) => a + b.rules.length, 0);
    const after = total - before;
    const parts = [];
    if (before) parts.push(`${before} 条在受管区**之前**(会被受管区覆盖 —— 想要它们生效, 挪到受管区之后)`);
    if (after) parts.push(`${after} 条在受管区之后(后出现者优先, 继续生效)`);
    return `受管区之外还有${label} ${total} 条: ${parts.join('; ')}`;
  };
  const statuses = KITS.map(k => {
    const blocks = findAllBlocks(src, k.id);
    const openCount = countOpenTags(src, k.id);
    if (openCount > blocks.length) {
      return { id: k.id, label: k.label, status: 'broken', detail: `有 ${openCount} 个开标记但只有 ${blocks.length} 个配对收尾(定界符被改坏)` };
    }
    if (blocks.length > 1) {
      return { id: k.id, label: k.label, status: 'duplicate', detail: `同一工具箱出现 ${blocks.length} 个受管块(块外的旧副本按层叠会覆盖新块)` };
    }
    const block = blocks[0];
    const clean = block && block.rev === rev && block.body.trim() === k.css.trim();
    const copies = legacyBlocks.filter(b => b.id === k.id && b.kind === 'copy');
    const overrides = legacyBlocks.filter(b => b.id === k.id && b.kind === 'override');
    if (copies.length) {
      return {
        id: k.id, label: k.label, status: 'legacy-outside',
        detail: `受管区之外还有 ${copies.length} 段旧版副本(整份/多条规则) —— 它们后出现, 按层叠会覆盖受管区; 升级会清掉这几段(原件在 tokens.css.bak)`,
      };
    }
    if (block && clean) {
      return overrides.length
        ? { id: k.id, label: k.label, status: 'ok', detail: overrideNote(overrides, '你自己的覆写规则') }
        : { id: k.id, label: k.label, status: 'ok' };
    }
    if (block) {
      return {
        id: k.id, label: k.label, status: 'stale',
        detail: block.rev === rev
          ? '受管块内容与 rev 不符(被手工改过)'
          : `受管块 rev ${block.rev.slice(0, 8)} 落后于技能当前 ${rev.slice(0, 8)}`,
      };
    }
    // 老格式(整段裸文本, 没有受管块): 内容与当前版逐字一致时渲染无差异 → 报 ok(不骚扰),
    // 只提示下次升级会补上受管块。注意这个分支必须排在 legacy-outside 之后 —— 否则
    // "区外还留着旧副本"会被这里的字符串命中掩盖掉(那正是重写前的旧缺陷)。
    if (src.includes(k.css.trim())) {
      return { id: k.id, label: k.label, status: 'ok', detail: '老格式(裸文本, 无受管块): 内容已是当前版, 渲染无差异; 下次 --upgrade-css 会补上受管块' };
    }
    return {
      id: k.id, label: k.label, status: 'missing',
      detail: k.probe(src) ? '文件里有旧版残留(与当前不同)' : '文件里没有这段',
    };
  });
  if (expected) statuses.unshift(tokensStatus(src, expected));
  return statuses;
}

/** 整段 tokens 受管区的状态(单独一个函数, 因为它比工具箱多一层"内容文本"比较) */
export function tokensStatus(css, { text, rev }) {
  const src = String(css ?? '').replace(/\r\n/g, '\n');
  const blocks = findAllBlocks(src, TOKENS_ID);
  const openCount = countOpenTags(src, TOKENS_ID);
  const want = String(text).replace(/\r\n/g, '\n').trim();
  const base = { id: TOKENS_ID, label: 'tokens 主体(主题/字号/fx/工具箱)' };
  if (openCount > blocks.length) return { ...base, status: 'broken', detail: `有 ${openCount} 个开标记但只有 ${blocks.length} 个配对收尾` };
  if (blocks.length > 1) return { ...base, status: 'duplicate', detail: `出现 ${blocks.length} 个 tokens 受管区` };
  if (!blocks.length) {
    // 老格式(无受管区): 文件里已经有**逐字相同**的当前版生成物时, 渲染结果与升级后完全一致,
    // 所以仍然报 ok(不骚扰), 只在 detail 里提示下次升级会就地包上受管区。
    // 但若出现了**两份**(旧追加式升级留下的), 必须报 duplicate: 后出现的那份按层叠会赢,
    // 不报就会变成"check 绿、成片却是旧值" —— 正是这套机制要堵的静默失效。
    const n = want ? src.split(want).length - 1 : 0;
    if (n === 1) {
      return { ...base, status: 'ok', detail: '老格式(裸文本, 无受管区): 内容已是当前版, 渲染无差异; 下次 --upgrade-css 会就地包上受管区(内容与位置都不变)' };
    }
    if (n > 1) {
      return { ...base, status: 'duplicate', detail: `文件里出现了 ${n} 份当前版生成物(旧追加式升级留下的) —— 后出现的那份按层叠会赢; 升级会归并为一` };
    }
    return { ...base, status: 'missing', detail: '没有 tokens 受管区(老项目: 升级会整段重建, 区外的项目自定义规则保留)' };
  }
  const b = blocks[0];
  // 受管区在、内容也对, 也要看**区外**有没有主体残留(A7 实测: 受管区后面粘着一段旧主体,
  // 旧值按层叠压过新版, 而判定只看区内, 报 ok)。主体段按体量判: ≥400 字符或 ≥3 条 → 报出来。
  const outsideCopies = legacyOutsideBlocks(src, { bodyText: want }).filter(x => x.id === TOKENS_ID && x.kind === 'copy');
  if (outsideCopies.length) {
    const n = outsideCopies.reduce((a, x) => a + x.rules.length, 0);
    // 说清位置: 在受管区**之前**的会被受管区覆盖(老格式升级就长这样: 生成物被追加到文件末尾,
    // 原来在文件尾的项目规则反而落到前面), 在之后的才会压过受管区。含糊其辞会让人按错误的
    // 方向去修(复查 A6 实测: 旧文案写"后出现者按层叠优先", 而实际布局正好相反)。
    const beforeRules = outsideCopies.reduce((a, x) => a + x.rules.filter(r => r.start < b.start).length, 0);
    const afterRules = n - beforeRules;
    const where = [];
    if (beforeRules) where.push(`${beforeRules} 条在受管区**之前**(会被受管区覆盖 —— 想要它们生效就挪到受管区之后)`);
    if (afterRules) where.push(`${afterRules} 条在受管区之后(后出现, 按层叠会覆盖受管区 —— 是旧残留就删掉)`);
    return {
      ...base, status: 'legacy-outside',
      detail: `受管区之外还有 ${outsideCopies.length} 段主体规则(共 ${n} 条): ${where.join('; ')}; 升级只清掉与当前版逐字相同的那几条`,
    };
  }
  if (b.rev === rev && b.body.trim() === want) {
    const overrides = legacyOutsideBlocks(src, { bodyText: want }).filter(x => x.id === TOKENS_ID && x.kind === 'override');
    const before = overrides.filter(x => x.start < b.start).reduce((a, x) => a + x.rules.length, 0);
    return overrides.length
      ? { ...base, status: 'ok', detail: `受管区之外还有你自己的规则 ${overrides.reduce((a, x) => a + x.rules.length, 0)} 条${before ? `(其中 ${before} 条在受管区**之前**, 会被受管区覆盖 —— 要生效就挪到之后)` : '(都在受管区之后, 后出现者优先)'}` }
      : { ...base, status: 'ok' };
  }
  return {
    ...base, status: 'stale',
    detail: b.rev === rev ? '受管区内容与 rev 不符(被手工改过)' : `受管区 rev ${b.rev.slice(0, 8)} 落后于技能当前 ${rev.slice(0, 8)}`,
  };
}

// ── 升级(原地) ───────────────────────────────────────────────────
// 只动受管区: tokens 区整体替换(内部含三个工具箱子块), 区外的项目自定义规则一字不动。
// 老项目(没有 tokens 区)会整段重建, 并且清掉散落在外面的旧 copies。
export function applyKitUpgrade(css, { rev = KIT_REV, tokensText = null, tokensRev = null } = {}) {
  const raw = String(css ?? '');
  let out = raw.replace(/\r\n/g, '\n');   // 与 rev 计算同标准; 写回即统一为 LF
  const actions = [];

  // 1) 孤儿开标记(定界符被改坏)先清掉 —— 否则重建时会叠加出第二个开标记
  for (const id of BLOCK_IDS) {
    const blocks = findAllBlocks(out, id);
    const opens = countOpenTags(out, id);
    if (opens > blocks.length) {
      // 先删掉所有配对块, 再删掉所有开标记(顺序不能反, 否则删标记会破坏配对)
      for (const b of blocks.reverse()) out = out.slice(0, b.start) + '\n' + out.slice(b.end);
      out = out.replace(OPEN_RE_G(id), '');
      actions.push({ id, label: id, action: 'cleaned-broken', reason: `${opens} 个开标记只有 ${blocks.length} 个配对收尾, 已清掉残留标记` });
    }
  }

  // 2) 同 id 多块 → 归并为一(保留第一块的位置, 删掉其余)
  for (const id of BLOCK_IDS) {
    const blocks = findAllBlocks(out, id);
    if (blocks.length > 1) {
      for (const b of blocks.slice(1).reverse()) out = out.slice(0, b.start) + '\n' + out.slice(b.end);
      actions.push({ id, label: id, action: 'merged-duplicates', reason: `${blocks.length} 个重复受管块已归并(否则块外那份按层叠会赢)` });
    }
  }

  // 3) tokens 受管区: 整段替换 / 就地包裹 / 追加到文件尾。
  //    这一步必须排在"清区外旧副本"**之前**: 老 init 直出的裸文本主体里本来就含三个工具箱的原文,
  //    而那时它们都还"不在任何受管区里" —— 先清就会把裸文本里的工具箱段删掉, 于是下面的
  //    indexOf 失配 → 既多插一份新生成物, 又把残缺的旧主体留在区内之外, 按层叠反而压过新版。
  //    (2026-09-18 实测: 就是这条顺序让"老项目升级"在 C 场景下产出重复内容 + 旧规则压新版。)
  if (tokensText != null) {
    const blocks = findAllBlocks(out, TOKENS_ID);
    const wrapped = `${openTag(TOKENS_ID, tokensRev)}\n${String(tokensText).replace(/\r\n/g, '\n').trim()}\n${closeTag(TOKENS_ID)}`;
    if (blocks.length === 1) {
      if (blocks[0].rev !== tokensRev || blocks[0].body.trim() !== String(tokensText).replace(/\r\n/g, '\n').trim()) {
        out = out.slice(0, blocks[0].start) + wrapped + out.slice(blocks[0].end);
        actions.push({ id: TOKENS_ID, label: 'tokens 主体', action: 'tokens-replaced', reason: '整段生成物已就地替换为技能当前版本(区之外的项目规则未动)' });
      }
    } else {
      // 没有 tokens 区(老项目/裸文本): 老 init 直出的主体里**嵌着**三个工具箱子块, 所以
      // "文件里是否已有当前版生成物"必须在**剥掉子块之前**判 —— 先剥就会让 indexOf 失配,
      // 于是多插一份、旧内容还留在后面按层叠压过新版(实测踩到)。
      const want = String(tokensText).replace(/\r\n/g, '\n').trim();
      const at = out.indexOf(want);
      if (at > -1) {
        out = out.slice(0, at) + wrapped + out.slice(at + want.length);
        actions.push({ id: TOKENS_ID, label: 'tokens 主体', action: 'tokens-wrapped', reason: '文件里已有当前版生成物(裸文本), 已就地包进受管区(内容不变, 位置不变)' });
      } else {
        // 别的内容: 先清掉散落的工具箱子块与旧副本, 再整段追加到**文件尾** ——
        // 生成物在层叠上后出现才压得住文件里残留的旧版内容(置于开头会被旧内容反压)
        for (const k of KITS) {
          for (const b of findAllBlocks(out, k.id).reverse()) out = out.slice(0, b.start) + '\n' + out.slice(b.end);
        }
        out = out.replace(/\s*$/, '\n') + '\n' + wrapped + '\n';
        actions.push({ id: TOKENS_ID, label: 'tokens 主体', action: 'tokens-appended', reason: '老项目: 整段生成物(含三个工具箱子块)已追加到文件末尾 —— 在你原有规则之后, 所以新版规则在层叠上生效; 你的项目规则原样保留在前(受管区内的规则以新版为准)' });
      }
    }
  } else {
    // 兼容: 只升级工具箱(不传 tokensText 时按旧语义逐块替换)
    let statuses = kitStatuses(out, { rev });
    for (const [i, k] of KITS.entries()) {
      if (statuses[i].status !== 'stale') continue;
      const b = findAllBlocks(out, k.id)[0];
      out = out.slice(0, b.start) + wrapKit(k.id, k.css, rev) + out.slice(b.end);
      actions.push({ id: k.id, label: k.label, action: 'replaced', reason: statuses[i].detail });
    }
    statuses = kitStatuses(out, { rev });
    for (const [i, k] of KITS.entries()) {
      const st = statuses[i];
      if (st.status === 'ok' && !st.detail) continue;
      const fresh = wrapKit(k.id, k.css, rev);
      const text = k.css.trim();
      const at = out.lastIndexOf(text);
      if (st.status === 'ok' && at > -1) {
        const before = out.slice(0, at).split(text).join('');
        out = before + fresh + out.slice(at + text.length);
        actions.push({ id: k.id, label: k.label, action: 'wrapped', reason: '内容已是当前版, 原地补上受管块定界符(位置不变)' });
        continue;
      }
      out = out.replace(/\s*$/, '\n') + '\n' + fresh + '\n';
      actions.push({ id: k.id, label: k.label, action: 'appended', reason: '缺失, 已追加受管块' });
    }
  }

  // 4) 区外残留的同内容副本: 受管区此时已就位, 这一步在"区之外"的视野里清旧副本
  //    (只删 kind='copy' 里逐字命中当前版的那些; 用户手写的规则与改过的旧规则都保留 ——
  //     见 removeLegacyCopies 的注释。bodyText 让主体残留(A7)也走同一条路)
  out = removeLegacyCopies(out, actions, { bodyText: tokensText });

  return { css: out, actions, normalizedLineEndings: /\r\n/.test(raw) };
}

// 区外的旧版副本: 逐条删除(升级的语义就是"把生成物之外多余的工具箱内容收拾干净";
// 备份在 .bak, 日志里会打印删了几条)。**只处理 kind='copy' 的段**, 而且按条判:
// 一段里"逐字来自模块原文"的前缀才是旧副本, 后面紧挨着的短尾巴(≤2 条)是用户自己写的覆写,
// 原地保留 —— "受管区之外的规则一概不动"这条承诺不能因为清理而破。
// 若尾巴很长(被改过多处的整份旧副本), 则整段清掉: 它留在那里就会按层叠压过受管区,
// 属于必须清掉的错误产物(原文在 .bak, 日志会点名)。
function removeLegacyCopies(css, actions, { bodyText = null } = {}) {
  const copies = legacyOutsideBlocks(css, { bodyText }).filter(b => b.kind === 'copy');
  const spans = [];
  let tokensRemoved = 0;
  for (const b of copies) {
    // 逐字来自"技能当前版"的规则才删: 工具箱对模块原文, 主体对当前生成物。主体段里那些改过的规则
    // (旧版残留 or 用户有意覆写 —— 光看文本分不出来)一律留在原地, 由人按 check 的提示决定。
    const ref = (b.id === TOKENS_ID ? String(bodyText ?? '') : KITS.find(k => k.id === b.id).css).replace(/\s+/g, ' ');
    // 主体段: 逐条判 —— 与当前版逐字相同的都删(它们是重复内容, 删了渲染不变), 改过的都留
    if (b.id === TOKENS_ID) {
      const same = b.rules.filter(r => ref.includes(r.text.replace(/\s+/g, ' ').trim()));
      const diff = b.rules.filter(r => !ref.includes(r.text.replace(/\s+/g, ' ').trim()));
      for (const r of same) spans.push({ start: r.start, end: r.end });
      tokensRemoved += same.length;
      if (diff.length) {
        const first = diff[0].text.replace(/\s+/g, ' ').trim().slice(0, 60);
        actions.push({
          id: TOKENS_ID, label: b.label, action: 'kept-legacy-overrides',
          reason: `受管区之外有 ${diff.length} 条**与当前版不同**的主体规则, 已原样保留(例: ${first}…) —— 它们是旧版残留还是你有意改的, 工具分不出来: 若是旧残留就删掉, 想让它生效就挪到受管区之后`,
        });
      }
      continue;
    }
    let i = 0;
    while (i < b.rules.length && ref.includes(b.rules[i].text.replace(/\s+/g, ' ').trim())) i++;
    const tail = b.rules.slice(i);
    // 工具箱: 尾巴太长 = 改过几处的整份旧副本, 整段清(它压在受管区上就是错误产物)
    const whole = tail.length > 2;
    for (const r of (whole ? b.rules : b.rules.slice(0, i))) spans.push({ start: r.start, end: r.end });
    if (!whole && tail.length) {
      actions.push({
        id: b.id, label: b.label, action: 'kept-legacy-overrides',
        reason: `受管区外与旧副本紧邻的 ${tail.length} 条规则未出现在技能原文里, 判为你自己的覆写并原地保留(它们后出现, 按层叠优先)`,
      });
    }
  }
  let out = css;
  // 片段先并集再删: 万一还有相交/嵌套的片段, 按偏移逐个删会错位(删掉后面的受管区)—— 2026-09-18 实测
  const union = [];
  for (const s of spans.sort((a, c) => a.start - c.start)) {
    const last = union[union.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else union.push({ ...s });
  }
  for (const s of union.sort((a, c) => c.start - a.start)) out = out.slice(0, s.start) + out.slice(s.end);
  const byKit = new Map();
  for (const b of copies) if (b.id !== TOKENS_ID) byKit.set(b.id, (byKit.get(b.id) ?? 0) + 1);
  for (const k of KITS) {
    const n = byKit.get(k.id) ?? 0;
    if (n) actions.push({ id: k.id, label: k.label, action: 'removed-legacy-outside', reason: `受管区外发现 ${n} 段旧版副本并已删除(后出现会按层叠覆盖受管区; 原件在 tokens.css.bak)` });
  }
  if (tokensRemoved) {
    actions.push({ id: TOKENS_ID, label: 'tokens 主体', action: 'removed-legacy-outside', reason: `受管区外发现 ${tokensRemoved} 条与当前版逐字相同的主体规则, 已删除(它们后出现会按层叠覆盖受管区; 原件在 tokens.css.bak)` });
  }
  return out;
}
