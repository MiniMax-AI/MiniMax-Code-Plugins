// html2video-for-mcode · 扫描上限(单一来源)
//
// 为什么单独一个文件: 这个上限对 **tokens.css 与 slide HTML 都生效**(check-slides / preview-page /
// capture 两侧都过同一道门), 但它原先住在 css-kit.mjs 里 —— 那是"受管块扫描"引入的, 于是 HTML 侧的
// 调用点看起来像在依赖 CSS 模块。搬到 tools.mjs 会成环(tools 已经 import css-kit 取 kitStatuses),
// 所以放在这个谁都能 import 的叶子模块里。
//
// 数值的理由: 受管块定位的正则对"无闭合定界符 × N"的构造输入是二次方复杂度 —— 2026-09-18 审计实测
// 4MB 恶意 tokens.css 会让 --check-css 跑 39s。正常 tokens.css ≈15KB、单张 slide ≈10KB,
// 2MB 只可能是构造出来的, 所以入口直接拒绝扫描并说明原因。
export const MAX_SCAN_BYTES = 2_000_000;
