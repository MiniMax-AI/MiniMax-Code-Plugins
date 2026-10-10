// html2video-for-mcode · 网络 URL 策略(纯函数, 供 asr.mjs / fetch-official-images.mjs 与测试复用)
// 两个职责:
//   1. 出网端点白名单 —— asr.mjs 只把 API Key 发往官方 MiniMax 域; 换端点必须显式
//      --allow-any-endpoint(危险项), 防止被环境变量/提示词偷换后凭证外发。
//   2. 抓图目标校验 —— fetch-official-images.mjs 的页面 URL、每个候选图 src、每一跳
//      重定向都过同一套 host 策略: 拦 loopback / 链路本地(含云元数据)/私网 / 无点主机名,
//      只允许 http(s), file:// 需显式 --allow-file, 禁 userinfo。
// host 判定是纯函数; DNS 相关(assertResolvedHost/checkedLookup/policyGet/startVetoProxy)
// 做 IO —— 那是它们的职责。抛 PolicyError(带 reason code)由调用方决定退出码与文案。

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

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
// 2026-09-18 复查补全: 除私网/回环/链路本地外, 还要拦保留段与文档段 ——
// 前者常被内网设备使用, 后者虽不可路由, 但放行等于把"地址分类"这层判断交给下游。
const BLOCKED_V4 = [
  [0b00000000, 8],        // 0.0.0.0/8        "this host"
  [10 << 24, 8],          // 10.0.0.0/8       私网
  [100 << 24 | 64 << 16, 10], // 100.64.0.0/10 CGNAT(常被漏掉的内网段)
  [127 << 24, 8],         // 127.0.0.0/8      loopback
  [169 << 24 | 254 << 16, 16], // 169.254.0.0/16 链路本地(含云元数据 169.254.169.254)
  [172 << 24 | 16 << 16, 12], // 172.16.0.0/12  私网
  [192 << 24 | 0 << 16, 24], // 192.0.0.0/24   IETF 协议保留
  [192 << 24 | 0 << 16 | 2 << 8, 24], // 192.0.2.0/24 TEST-NET-1
  [192 << 24 | 168 << 16, 16],// 192.168.0.0/16 私网
  [198 << 24 | 18 << 16, 15], // 198.18.0.0/15  基准测试段
  [198 << 24 | 51 << 16 | 100 << 8, 24], // 198.51.100.0/24 TEST-NET-2
  [203 << 24 | 0 << 16 | 113 << 8, 24],  // 203.0.113.0/24 TEST-NET-3
  [224 << 24, 4],         // 224.0.0.0/4     组播
  [240 << 24, 4],         // 240.0.0.0/4     保留(含 255.255.255.255)
].map(([base, bits]) => [base >>> 0, bits]);

// host 是否属于禁止出网/抓取的地址(或形态)
export function isBlockedHost(hostname) {
  // 尾点 FQDN 归一: `localhost.` 与 `localhost` 是同一个名字(RFC 1034 绝对名),
  // 只判裸名会让 `http://localhost./` 直接穿过去(2026-09-18 实测放行)
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  if (h.includes(':')) { // IPv6
    if (h === '::' || h === '::1') return true;                    // unspecified / loopback
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;                 // fc00::/7 私网(ULA)
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;                 // fe80::/10 链路本地
    if (/^fec[0-9a-f]:/.test(h)) return true;                      // fec0::/10 站点本地(已废弃)
    if (/^2001:0?db8:/.test(h)) return true;                       // 2001:db8::/32 文档段
    // 内嵌 IPv4 的三种载体都要换算回点分再判, 否则可借壳穿透:
    //   ::ffff:x:y   IPv4-mapped(WHATWG URL 会把点分规范成 hex 组)
    //   64:ff9b::x:y NAT64   6to4 2002:AABB:CCDD::/48(前 32 位就是 IPv4)
    const embedded = (() => {
      let m = /^::ffff:(.+)$/.exec(h);
      if (m) return m[1];
      m = /^64:ff9b::(.+)$/.exec(h);
      if (m) return m[1];
      m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/.exec(h);
      if (m) {
        const hi = parseInt(m[1], 16) >>> 0, lo = parseInt(m[2], 16) >>> 0;
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      }
      return null;
    })();
    if (embedded) {
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded);   // 两个 hex 组 = 32 位 IPv4
      if (m) {
        const hi = parseInt(m[1], 16) >>> 0, lo = parseInt(m[2], 16) >>> 0;
        return isBlockedHost(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
      }
      return isBlockedHost(embedded);      // 已经是点分或还带别的形态, 继续判
    }
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
  if (['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'].some(sfx => h.endsWith(sfx))) return true;
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

// 解析后再验一层(2026-09-18 二审 P1): 字符串层拦得住字面 IP, 拦不住"公网域名解析回内网"
// (DNS rebinding / 内网域名)。**每个真实请求**都要过这里 —— 页面导航、它的重定向、浏览器子资源、
// 逐跳下载 —— 否则策略只覆盖了"最初输入的那个 URL"。lookup 可注入(测试用假解析器, 无需真 DNS)。
// 2026-09-25 六审 blocker 1: 解析失败/空答案不再放行 —— 旧实现 catch 后 return 等于
// "解析不了就放行"(fail open), 钉死的语义应该是 fail closed。
export async function assertResolvedHost(urlStr, { lookup, where = 'url' } = {}) {
  let h;
  try { h = new URL(urlStr).hostname; } catch { return; }
  if (!h || !h.includes('.')) return;              // 裸主机名/非法 URL 已被字符串层拦掉
  const doLookup = lookup || (async name => dns.promises.lookup(name, { all: true }));
  let addr;
  try {
    addr = await doLookup(h);
  } catch (e) {
    throw new PolicyError('dns-error', `${where}: ${h} 解析失败(${e?.message ?? e}) — fail closed, 拒绝继续`);
  }
  const list = (Array.isArray(addr) ? addr : [addr]).filter(a => a && typeof a.address === 'string');
  if (!list.length) throw new PolicyError('dns-error', `${where}: ${h} 解析结果为空 — fail closed`);
  const bad = list.find(a => isBlockedHost(a.address));
  if (bad) throw new PolicyError('dns-rebinding', `${where}: ${h} 解析到被拦地址 ${bad.address}(DNS rebinding 或内网域名? 换官方 CDN 直链)`);
}

// ── 连接期绑定(2026-09-25 六审 blocker 1) ─────────────────────────
// 预查(assertResolvedHost)与真正建连之间隔着一次**独立解析** —— 攻击面就是这道缝:
// 预查时公网、建连时私网(DNS rebinding), 或两台解析器答案不一致。唯一权威的检查点是
// socket 建连用的那次 lookup。本节三个件:
//   checkedLookup   把否决权挂到 http(s)/net 的 lookup 选项上(Node lookup 兼容签名)
//   policyGet       配套出网 GET(不跟重定向, 由调用方逐跳复核), 建连带否决
//   startVetoProxy  浏览器(Chromium 自己解析, 注入不了 lookup)的全部出网收进本地隧道,
//                   上游建连仍走同一否决

// Node lookup 签名 (hostname, options, callback) 的策略包装: 解析失败按失败处理(建连即败,
// fail closed); 结果里**任何一个**地址被拦就整体拒绝 —— Happy-Eyeballs 会在地址列表里挑,
// "部分放行"等于没拦。resolve 可注入(与 assertResolvedHost 的 lookup 同一形态, 测试免真 DNS)。
export function checkedLookup(resolve) {
  const doResolve = resolve || ((name, opts) => dns.promises.lookup(name, { family: opts?.family ?? 0, hints: opts?.hints, all: true }));
  return (hostname, options, callback) => {
    doResolve(hostname, options).then(raw => {
      const all = (Array.isArray(raw) ? raw : [raw]).filter(a => a && typeof a.address === 'string');
      const fam = options?.family;
      const pool = (fam === 4 || fam === 6) ? all.filter(a => a.family === fam) : all;
      if (!pool.length) return callback(new Error(`dns: ${hostname} 无可用解析结果${fam ? `(family ${fam})` : ''}`));
      const bad = pool.find(a => isBlockedHost(a.address));
      if (bad) return callback(new PolicyError('dns-rebinding', `建连: ${hostname} 解析到被拦地址 ${bad.address}(连接期否决)`));
      // 只行使否决权, 不改变解析语义: 原样回传让 net 自己挑地址
      if (options?.all) return callback(null, pool);
      callback(null, pool[0].address, pool[0].family);
    }, callback);
  };
}

// 出网 GET, 建连那次解析经 checkedLookup 否决。不跟重定向 —— 重定向由调用方逐跳复核
// (fetch-official-images 的 followRedirects), 每一跳的建连都被单独否决。
// 返回与 followRedirects 的 get 契约一致的归一化结果。maxBytes 在**流式读取时**掐断,
// 不信用 content-length(恶意服务器会谎报)。createConnection 仅测试注入假上游用。
export function policyGet(rawUrl, { headers = {}, timeoutMs = 30000, maxBytes = Infinity, lookup, createConnection } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch { return reject(new PolicyError('bad-url', String(rawUrl))); }
    // 建连**之前**的字符串层 host 策略(七审 blocker 1): IP 字面量目标根本不走 lookup ——
    // Node 直接连 IP, checkedLookup 对它是空转, 于是 "http://127.0.0.1:8080/" 这类目标
    // 没有任何否决点(生产 startVetoProxy 的绝对形式 HTTP 分支经本地 origin 实测拿到 200
    // 且 origin 实收请求)。这一层是所有 policyGet 调用方的**唯一**字面量入口。
    try { assertFetchableUrl(u.href, { where: 'policy-get' }); }
    catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) return reject(new PolicyError('bad-scheme', String(u.protocol)));
    const req = mod.request(u, {
      headers,
      lookup: checkedLookup(lookup),
      ...(createConnection ? { createConnection } : { agent: false }),   // agent:false = 不留池化连接(工具进程要能自然退出)
    }, res => {
      const chunks = []; let total = 0;
      res.on('data', c => {
        total += c.length;
        if (total > maxBytes) { res.destroy(new Error(`响应超限: 已收 ${(total / 1048576).toFixed(0)}MB 超过上限(读取中途掐断, 不信用 content-length)`)); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location,
        headers: { ...res.headers },
        header: n => res.headers[String(n).toLowerCase()] || '',
        arrayBuffer: async () => Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时(${timeoutMs}ms): ${u.host}`)));
    req.on('error', reject);
    req.end();
  });
}

// 本地否决代理: Chromium 的页面导航/子资源自己解析 DNS, 没有 lookup 钩子可注入 ——
// 把它的全部出网收进这条隧道才能把策略绑到"实际建连的那次解析"上:
//   CONNECT(https) → 上游建连带 checkedLookup, 建连前还做一次字符串层+解析预否决(可命名告警)
//   绝对形式 http  → 经 policyGet 出网(连接期否决), 原样回贴
// 只监听 127.0.0.1(它本身就是策略咽喉, 不是出网目标)。connect 可注入(测试假上游)。
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
export async function startVetoProxy({ lookup, connect = net.connect, maxBytes = 30 * 1024 * 1024 } = {}) {
  const sockets = new Set();
  const track = s => { sockets.add(s); s.on('close', () => sockets.delete(s)); return s; };
  const server = http.createServer((req, res) => {
    if (!req.url || !/^https?:\/\//i.test(req.url)) { res.writeHead(400); return res.end('veto-proxy: 只收绝对形式 URL'); }
    // 每个代理 HTTP 请求都先过 host 策略(与下面 CONNECT 分支同形的可命名预否决): 字面量
    // 目标不触发 checkedLookup, 缺这道预否决时 policyGet 之前的绝对形式分支等于没有闸门。
    try { assertFetchableUrl(req.url, { where: '代理 HTTP' }); }
    catch (e) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(`veto-proxy: ${e.message}`); }
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host' || HOP_BY_HOP.includes(k)) continue;   // Host 由目标 URL 决定, 逐跳头不转发
      fwd[k] = v;
    }
    policyGet(req.url, { headers: fwd, lookup, createConnection: connect, maxBytes, timeoutMs: 45000 })
      .then(async r => {
        const out = { ...r.headers };
        delete out['transfer-encoding']; delete out['connection'];   // 已整包缓冲, 传输头自算
        res.writeHead(r.status, out);
        res.end(await r.arrayBuffer());
      })
      .catch(e => {
        try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`veto-proxy: ${e.message}`); }
        catch { /* 客户端已断 */ }
      });
  });
  server.on('connect', (req, clientSocket, head) => {
    const fail = () => clientSocket.destroy();
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url || '');
    if (!m) return fail();
    const host = m[1], port = parseInt(m[2], 10);
    const bare = host.replace(/^\[|\]$/g, '');
    const literal = /^[\d.]+$/.test(bare) || (bare.includes(':') && /^[0-9a-f:]+$/i.test(bare));
    (async () => {
      if (isBlockedHost(bare)) throw new PolicyError('blocked-host', `代理 CONNECT: ${bare}`);
      // 名字(非字面 IP)先做一次可命名的预否决; 权威检查点仍是下面建连里的 checkedLookup
      if (!literal && (bare.includes('.') || bare.includes(':'))) {
        await assertResolvedHost(`https://${bare}/`, { lookup, where: '代理 CONNECT' });
      }
      const up = track(connect({ host, port, lookup: checkedLookup(lookup), noDelay: true }, () => {
        track(clientSocket);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      }));
      up.on('error', fail);
      clientSocket.on('error', () => up.destroy());
      up.on('close', () => clientSocket.destroy());
      clientSocket.on('close', () => up.destroy());
    })().catch(() => fail());
  });
  server.on('connection', track);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); },
  };
}

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
