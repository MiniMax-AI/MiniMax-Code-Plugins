// html2video-for-mcode · CSS 工具箱的受管块机制(单一来源 → 项目 tokens.css 的可检测传播)。
//
// 背景(2026-09-18 排查定案的根因): 旧 --upgrade-css 用"存在性探针"判定(查 1–2 个标记字符串),
// 项目一旦补过一次就永远报"无需升级" —— 源模块(nofx/chart/table)后续改动再也传播不过去;
// 追加式升级还会压掉项目端覆写并留下整份重复块。现在改为:
//   1. 三个工具箱在 tokens.css 里以"受管块"存在, 定界注释携带内容 rev;
//   2. rev = sha256(三个模块 CSS 文本), 内容变则 rev 变 —— 判定看内容, 不再只看"出现过没有";
//   3. --upgrade-css 按 rev 原地替换受管块(块外一概不动, 覆写安全; 写前备份 .bak);
//   4. --check-css / check-slides / preview-page 复用同一判定, 把"项目落后"变成可见的提示。
// 边界(如实声明): rev 只覆盖三个受管块能传播的内容; tokens.css 的模板主体(主题/字号/fx 工具类)
// 仍内联在 init-project.mjs 里, 改它需要 --force 重新生成或手工同步 —— 受管块管不到。

import { createHash } from 'node:crypto';
import { NOFX_CSS, hasNofxRules } from './nofx-css.mjs';
import { CHART_CSS, hasChartKit } from './chart-css.mjs';
import { TABLE_CSS, hasTableKit } from './table-css.mjs';

// 受管块定位的惰性正则对"无闭合定界符 × N"的构造输入是二次方复杂度 —— 入口统一拒绝超大
// 输入(正常 tokens.css ≈15KB、单张 slide ≈10KB, 2MB 只可能是构造的; 2026-09-18 审计实测
// 4MB 恶意文件会让 --check-css 跑 39s)。check-slides / preview-page / init-project 共用此上限。
export const MAX_SCAN_BYTES = 2_000_000;

export const KITS = [
  { id: 'nofx', label: 'no-fx 规则', css: NOFX_CSS, probe: hasNofxRules },
  { id: 'chart', label: '图表工具箱', css: CHART_CSS, probe: hasChartKit },
  { id: 'table', label: '表格原语', css: TABLE_CSS, probe: hasTableKit },
];

// rev 对"块里实际会写进项目的 CSS"求哈希: 三个模块的文本逐字决定 rev, 注释/格式微调不改变
// 块内容的也不影响; init-project.mjs 自身的改动(模板主体)不参与 —— 它本来就不受管, 不该让 rev 说谎。
export const KIT_REV = createHash('sha256')
  .update(KITS.map(k => k.css).join('\n').replace(/\r\n/g, '\n'))
  .digest('hex');

export const openTag = (id, rev = KIT_REV) => `/* >>> html2video:${id} rev=${rev} >>> */`;
export const closeTag = id => `/* <<< html2video:${id} <<< */`;
export function wrapKit(id, css, rev = KIT_REV) {
  return `${openTag(id, rev)}\n${String(css).trim()}\n${closeTag(id)}`;
}

const BLOCK_RE = id => new RegExp(
  `/\\* >>> html2video:${id} rev=([0-9a-f]{8,64}) >>> \\*/([\\s\\S]*?)/\\* <<< html2video:${id} <<< \\*/`);

// 找到一个受管块: { start, end, rev, body } | null
export function findBlock(css, id) {
  const m = BLOCK_RE(id).exec(String(css ?? ''));
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, rev: m[1], body: m[2] };
}

function indicesOf(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i > -1) { out.push(i); i = hay.indexOf(needle, i + needle.length); }
  return out;
}

// 每个工具箱在项目 tokens.css 里的状态:
//   ok      受管块存在且 rev/内容与技能当前一致(内容当前但无定界符的老文件也算 ok —— 内容对就行)
//   stale   受管块存在但 rev 落后, 或块内容与 rev 不符(被手工改过) → 原地替换
//   missing 既无受管块也无当前内容(可能有旧版残留) → 追加受管块
export function kitStatuses(css, { rev = KIT_REV } = {}) {
  // 行尾先归一: KIT_REV 哈希是按 LF 算的, 内容比较必须同一标准 —— 否则 git autocrlf 检出的
  // CRLF 文件会被误报三段"被手工改过"(2026-09-18 实测)
  const src = String(css ?? '').replace(/\r\n/g, '\n');
  return KITS.map(k => {
    const block = findBlock(src, k.id);
    if (block) {
      if (block.rev === rev && block.body.trim() === k.css.trim()) {
        return { id: k.id, label: k.label, status: 'ok' };
      }
      return {
        id: k.id, label: k.label, status: 'stale',
        detail: block.rev === rev
          ? '受管块内容与 rev 不符(被手工改过)'
          : `受管块 rev ${block.rev.slice(0, 8)} 落后于技能当前 ${rev.slice(0, 8)}`,
      };
    }
    if (src.includes(k.css.trim())) {
      return { id: k.id, label: k.label, status: 'ok', detail: '内容当前, 但还没有受管块定界符' };
    }
    return {
      id: k.id, label: k.label, status: 'missing',
      detail: k.probe(src) ? '文件里有旧版残留(与当前不同)' : '文件里没有这段',
    };
  });
}

// 计划(并执行)升级。只动受管块与工具箱内容, 其他字符一律原样保留:
//   replaced  受管块存在但旧/被改 → 原位换成本次的新块(第一阶段, 块级重写互不影响)
//   wrapped   无受管块但内容已是当前版 → 原地把这段文本包上定界符(位置不变, 重复副本一并去重)
//   appended  缺失 → 文件尾追加受管块(CSS 后写覆盖, 残留旧规则不再生效)
// wrapped/appended 放第二阶段并对第一阶段的结果重估: 单趟里 wrapped 的插入点可能恰好落在
// 另一个待替换的旧受管块内部, 随后的 replaced 会把刚包进去的块一起清掉(2026-09-18 审计抓到)。
export function applyKitUpgrade(css, { rev = KIT_REV } = {}) {
  const raw = String(css ?? '');
  let out = raw.replace(/\r\n/g, '\n');   // 与 KIT_REV/kitStatuses 同标准; 写回即统一为 LF
  const actions = [];
  let statuses = kitStatuses(out, { rev });
  for (const [i, k] of KITS.entries()) {
    if (statuses[i].status !== 'stale') continue;
    const block = findBlock(out, k.id);
    out = out.slice(0, block.start) + wrapKit(k.id, k.css, rev) + out.slice(block.end);
    actions.push({ id: k.id, label: k.label, action: 'replaced', reason: statuses[i].detail });
  }
  statuses = kitStatuses(out, { rev });
  for (const [i, k] of KITS.entries()) {
    const st = statuses[i];
    if (st.status === 'ok' && !st.detail) continue;           // 受管块已就位且最新
    const fresh = wrapKit(k.id, k.css, rev);
    if (st.status === 'ok') {                                  // 内容当前但无定界符 → 原地包裹
      const text = k.css.trim();
      const at = out.lastIndexOf(text);
      const before = out.slice(0, at).split(text).join('');    // 顺带清掉旧追加时代留下的重复副本
      out = before + fresh + out.slice(at + text.length);
      actions.push({ id: k.id, label: k.label, action: 'wrapped', reason: '内容已是当前版, 原地补上受管块定界符(位置不变)' });
      continue;
    }
    out = out.replace(/\s*$/, '\n') + '\n' + fresh + '\n';
    actions.push({
      id: k.id, label: k.label, action: 'appended',
      reason: k.probe(out)
        ? '旧版残留与当前版不同, 新块已追加在文件尾 —— CSS 后写覆盖, 旧规则不再生效(若你在文件尾覆写过这段的规则, 请把覆写挪到受管块之后)'
        : '原本缺失, 已在文件尾补上受管块',
    });
  }
  return { css: out, actions, normalizedLineEndings: /\r\n/.test(raw) };
}
