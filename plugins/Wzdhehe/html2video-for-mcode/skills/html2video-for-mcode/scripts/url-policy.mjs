// html2video-for-mcode · 网络 URL 策略(纯函数, 供 asr.mjs / fetch-official-images.mjs 与测试复用)
// 两个职责:
//   1. 出网端点白名单 —— asr.mjs 只把 API Key 发往官方 MiniMax 域; 换端点必须显式
//      --allow-any-endpoint(危险项), 防止被环境变量/提示词偷换后凭证外发。
//   2. 抓图目标校验 —— fetch-official-images.mjs 的页面 URL、每个候选图 src、每一跳
//      重定向都过同一套 host 策略: 拦 loopback / 链路本地(含云元数据)/私网 / 无点主机名,
//      只允许 http(s), file:// 需显式 --allow-file, 禁 userinfo。
// 全部为纯函数, 不做 IO; 抛 PolicyError(带 reason code)由调用方决定退出码与文案。

export const OFFICIAL_ASR_BASES = ['https://api.minimaxi.com', 'https://api.minimax.io'];

export class PolicyError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail ?? ''}`);
    this.reason = reason;
    this.detail = detail;
  }
}

// ── host 判定 ────────────────────────────────────────────────────

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((a, p) => a * 256 + p, 0);
}

// [网络基址, 前缀位数]; 计算一律走无符号, 避开 int32 符号位比较的坑
const BLOCKED_V4 = [
  [0b00000000, 8],        // 0.0.0.0/8        "this host"
  [10 << 24, 8],          // 10.0.0.0/8       私网
  [100 << 24 | 64 << 16, 10], // 100.64.0.0/10 CGNAT(常被漏掉的内网段)
  [127 << 24, 8],         // 127.0.0.0/8      loopback
  [169 << 24 | 254 << 16, 16], // 169.254.0.0/16 链路本地(含云元数据 169.254.169.254)
  [172 << 24 | 16 << 16, 12], // 172.16.0.0/12  私网
  [192 << 24 | 168 << 16, 16],// 192.168.0.0/16 私网
].map(([base, bits]) => [base >>> 0, bits]);

// host 是否属于禁止出网/抓取的地址(或形态)
export function isBlockedHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, ''); // IPv6 字面量去方括号
  if (!h) return true;
  if (h.includes(':')) { // IPv6
    if (h === '::' || h === '::1') return true;                    // unspecified / loopback
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;                 // fc00::/7 私网(ULA)
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;                 // fe80::/10 链路本地
    if (/^::ffff:/.test(h)) return isBlockedHost(h.replace(/^::ffff:/, '')); // IPv4-mapped
    return false;
  }
  const ipv4 = ipv4ToLong(h);
  if (ipv4 !== null) {
    for (const [base, prefixBits] of BLOCKED_V4) {
      const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
      if (((ipv4 & mask) >>> 0) === ((base & mask) >>> 0)) return true;
    }
    return false;
  }
  // 非字面量: 无点主机名(localhost / 内网裸名 / NetBIOS)拦下; 内网风格后缀拦下
  if (!h.includes('.')) return true;
  if (h === 'localhost' || ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'].some(sfx => h.endsWith(sfx))) return true;
  return false;
}

// ── 出网端点(asr) ────────────────────────────────────────────────

// base 必须是官方端点; 允许用 --base-url/env 在两个官方域之间切换(region 对齐),
// 任何其他值都拒 —— 除非 allowAny(显式危险项)。http 一律拒绝(官方端点全是 https)。
export function assertAsrEndpoint(base, { allowAny = false } = {}) {
  const normalized = String(base ?? '').replace(/\/+$/, '');
  if (OFFICIAL_ASR_BASES.includes(normalized)) return normalized;
  if (allowAny) {
    let u;
    try { u = new URL(normalized); } catch { throw new PolicyError('bad-url', normalized); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PolicyError('bad-scheme', normalized);
    console.warn(`⚠ --allow-any-endpoint: API Key 将发往非官方端点 ${normalized}(自担风险, 仅用于自建网关/测试)`);
    return normalized;
  }
  throw new PolicyError('endpoint-not-allowed',
    `${normalized} 不在 ASR 端点白名单(${OFFICIAL_ASR_BASES.join(' / ')})。确需自定义请显式加 --allow-any-endpoint`);
}

// ── 抓图目标(fetch-official-images) ─────────────────────────────

// 校验一个要访问的 URL; allowFile 时放行 file: 协议(本地离线页是文档化场景)
export function assertFetchableUrl(raw, { allowFile = false, where = 'url' } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new PolicyError('bad-url', `${where}: ${raw}`); }
  if (u.protocol === 'file:') {
    if (!allowFile) throw new PolicyError('file-not-allowed', `${where}: file:// 需要显式 --allow-file`);
    if (u.username || u.password) throw new PolicyError('userinfo', where);
    return u;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PolicyError('bad-scheme', `${where}: ${u.protocol}`);
  if (u.username || u.password) throw new PolicyError('userinfo', `${where}: 带凭据的 URL`); // 凭据会进日志/请求头
  if (isBlockedHost(u.hostname)) throw new PolicyError('blocked-host', `${where}: ${u.hostname} 是内网/本地/元数据地址`);
  return u;
}

// 重定向跳转是否允许(逐跳调用; 每一跳都要过同一套校验)
export function assertRedirectTarget(location, { where = 'redirect' } = {}) {
  return assertFetchableUrl(location, { allowFile: false, where });
}

export const MAX_REDIRECTS = 5;

// ── 落盘文件名(抓图下载) ─────────────────────────────────────────

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// alt/标题转成安全文件名: 去路径分隔符与控制字符、压长度、挡 Windows 保留名与开头点/空格
export function sanitizeFilename(name, { maxLen = 30, fallback = 'official' } = {}) {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.\s-]+/, '')            // 不允许开头点/空格/连字符(点开头=隐藏文件)
    .replace(/[.\s-]+$/, '')
    .slice(0, maxLen)
    .replace(/^[.\s-]+|[.\s-]+$/g, ''); // 截断后再清一次边缘
  if (!s || WIN_RESERVED.test(s)) s = fallback;
  return s;
}

// 图片 URL → 落盘文件名(下载零散 URL 时用): 取路径末段, 扩展名优先用 URL 自己的,
// 没有/不像扩展名就按 content-type 推, 都不行给 .bin(交给人眼确认后再登记)。
const EXT_BY_TYPE = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif',
};

export function imageNameFromUrl(raw, contentType = '') {
  let pathname = '', base = '';
  try {
    pathname = new URL(raw).pathname;
    base = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch { /* 非法 URL: 走 fallback */ }
  const extInPath = /^\.[a-z0-9]{1,5}$/i.test(pathname.slice(pathname.lastIndexOf('.'))) ? pathname.slice(pathname.lastIndexOf('.')).toLowerCase() : '';
  const ext = extInPath || EXT_BY_TYPE[String(contentType).split(';')[0].trim().toLowerCase()] || '.bin';
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
  return sanitizeFilename(stem, { maxLen: 30, fallback: 'official' }) + ext;
}
