// 连接期绑定(2026-09-25 六审 blocker 1): 两件事 —— ① 解析失败从"放行"改为 fail closed;
// ② 策略从"请求前预查"绑到"实际建连的那次解析"上(预查时公网、建连时私网 = DNS rebinding 的缝)。
// 判据锚在"被拒目标收到 0 个连接"这类几何事实上, 不看文案; 假解析器注入走 url-policy 的
// lookup/resolve 接缝, 不需要真 DNS。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, tmpdir, SCRIPTS } from './helpers.mjs';
import { assertResolvedHost, checkedLookup, policyGet, startVetoProxy, PolicyError } from '../scripts/url-policy.mjs';

const PUB = [{ address: '93.184.216.34', family: 4 }];   // example.com 的公网地址, 只当"公网样子"用
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

const listen = (srv, host = '127.0.0.1') => new Promise(r => srv.listen(0, host, r));

describe('fail closed: 解析失败/空答案不再是放行(六审 blocker 1 前半)', () => {
  test('assertResolvedHost: 解析器抛错 → 拒绝(旧实现静默放行)', async () => {
    await assert.rejects(
      () => assertResolvedHost('https://gone.example.com/x.png', { lookup: async () => { throw new Error('ENOTFOUND gone.example.com'); } }),
      e => e instanceof PolicyError,
    );
  });
  test('assertResolvedHost: 空答案 → 拒绝', async () => {
    await assert.rejects(
      () => assertResolvedHost('https://empty.example.com/x', { lookup: async () => [] }),
      e => e instanceof PolicyError,
    );
  });
});

describe('checkedLookup(连接期否决, Node lookup 兼容签名)', () => {
  // 断言不能写进 lookup 的 callback 里直接抛 —— 抛错会落进 .then 吞成 unhandled rejection,
  // 测试假绿(否决被临时拿掉时当场抓到); 一律先 await 捕获结果再断言。
  const call = (lk, host, opts) => new Promise(res => lk(host, opts, (...a) => res(a)));

  test('公网地址原样放行(单地址与 all 两种回传形态)', async () => {
    const lk = checkedLookup(async () => PUB);
    const [e1, list] = await call(lk, 'ok.example.com', { all: true });
    assert.equal(e1, null); assert.deepEqual(list, PUB);
    const [e2, addr, fam] = await call(lk, 'ok.example.com', {});
    assert.equal(e2, null); assert.equal(addr, '93.184.216.34'); assert.equal(fam, 4);
  });
  test('解析到被拦地址 → callback 收到 dns-rebinding, 建连必败', async () => {
    const lk = checkedLookup(async () => LOOPBACK);
    const [e] = await call(lk, 'rebind.example.com', { all: true });
    assert.ok(e instanceof PolicyError, '应抛 PolicyError, 实得: ' + e);
    assert.equal(e.reason, 'dns-rebinding');
  });
  test('解析器报错 → 错误透传(建连失败, 不降级放行)', async () => {
    const lk = checkedLookup(async () => { throw new Error('ESERVFAIL'); });
    const [e] = await call(lk, 'x.example.com', { all: true });
    assert.match(String(e?.message), /ESERVFAIL/);
  });
});

describe('policyGet: 建连那次解析被否决(rebinding 的权威检查点)', () => {
  test('连接期解析回环 → 拒绝, 目标服务器收到 0 个请求(真走 net.lookup 路径, 无注入建连)', async () => {
    let hits = 0;
    const srv = http.createServer((q, s) => { hits++; s.writeHead(200); s.end('x'); });
    await listen(srv);
    try {
      await assert.rejects(
        () => policyGet(`http://rebind.example.test:${srv.address().port}/a.png`, { lookup: async () => LOOPBACK }),
        e => /被拦地址|dns-rebinding/.test(e.message),
      );
      assert.equal(hits, 0, '否决必须发生在连接之前 —— 服务器一个请求都不能收到');
    } finally { srv.close(); }
  });
  test('管道贯通: 状态/头/体回传正确, lookup 确实接线到建连层', async () => {
    const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'image/png' }); s.end('PNGDATA'); });
    await listen(srv);
    let sawLookup = false;
    try {
      const res = await policyGet(`http://ok.example.test:${srv.address().port}/a.png`, {
        lookup: async () => PUB,
        // createConnection 仅替换传输(测试假上游): lookup 必须作为建连参数传进来, 否则否决没接线
        createConnection: opts => { sawLookup = typeof opts.lookup === 'function'; return net.connect({ host: '127.0.0.1', port: srv.address().port }); },
      });
      assert.equal(sawLookup, true, 'lookup 必须传进建连层');
      assert.equal(res.status, 200);
      assert.equal(res.header('content-type'), 'image/png');
      assert.equal(String(await res.arrayBuffer()), 'PNGDATA');
    } finally { srv.close(); }
  });
  test('响应超限在读取中途掐断(不信用 content-length)', async () => {
    const srv = http.createServer((q, s) => { s.writeHead(200); s.end('A'.repeat(64)); });  // 不写长度=分块, 全量送达
    await listen(srv);
    try {
      await assert.rejects(
        () => policyGet(`http://ok.example.test:${srv.address().port}/big`, {
          lookup: async () => PUB,
          createConnection: () => net.connect({ host: '127.0.0.1', port: srv.address().port }),
          maxBytes: 16,
        }),
        e => /超限/.test(e.message),
      );
    } finally { srv.close(); }
  });
});

describe('startVetoProxy: 浏览器全部出网的否决隧道', () => {
  const lookupByName = map => async name => map[name] ?? PUB;
  // 注入的 connect 必须保留第二参 connectListener —— 生产路径 net.connect(options, cb) 靠它回调
  const connectTo = port => (opts, cb) => net.connect({ host: '127.0.0.1', port }, cb);

  function connectHandshake(port) {
    // 模拟浏览器侧: 裸 socket 发 CONNECT / 绝对形式请求由各用例自己拼
    return net.connect({ host: '127.0.0.1', port });
  }

  test('CONNECT 公网名 → 隧道建立且双向通(回显上游)', async () => {
    const echo = net.createServer(sock => sock.on('data', d => sock.write(d)));
    await listen(echo);
    const proxy = await startVetoProxy({ lookup: lookupByName({}), connect: connectTo(echo.address().port) });
    try {
      const verdict = await new Promise((resolve, reject) => {
        const c = connectHandshake(proxy.port);
        let phase = 'head', buf = '';
        const timer = setTimeout(() => { c.destroy(); reject(new Error('隧道握手/回显超时')); }, 5000);
        c.on('connect', () => c.write('CONNECT ok.example.com:443 HTTP/1.1\r\n\r\n'));
        c.on('data', d => {
          buf += d.toString('latin1');
          if (phase === 'head') {
            if (!buf.includes('\r\n\r\n')) return;
            assert.ok(/^HTTP\/1\.1 200/.test(buf), `握手应 200: ${buf.slice(0, 40)}`);
            phase = 'echo'; c.write('PING');
          } else if (buf.endsWith('PING')) { clearTimeout(timer); c.destroy(); resolve('tunnel-ok'); }
        });
        c.on('error', e => { clearTimeout(timer); reject(e); });
      });
      assert.equal(verdict, 'tunnel-ok');
    } finally { proxy.close(); echo.close(); }
  });

  test('CONNECT 解析回环(rebinding) → 建连前拒绝, 上游收到 0 个连接', async () => {
    const echo = net.createServer(sock => sock.on('data', d => sock.write(d)));
    await listen(echo);
    let upstreamConnects = 0;
    const proxy = await startVetoProxy({
      lookup: lookupByName({ 'rebind.example.com': LOOPBACK }),
      connect: opts => { upstreamConnects++; return connectTo(echo.address().port)(opts); },
    });
    try {
      const refused = await new Promise(resolve => {
        const c = connectHandshake(proxy.port);
        c.on('connect', () => c.write('CONNECT rebind.example.com:443 HTTP/1.1\r\n\r\n'));
        c.on('data', () => { c.destroy(); resolve('got-data'); });
        c.on('error', () => resolve('closed'));   // destroy 可能以 ECONNRESET 形态到达
        c.on('close', () => resolve('closed'));
        setTimeout(() => { c.destroy(); resolve('timeout'); }, 5000);
      });
      assert.equal(refused, 'closed', '必须被掐断, 不许出现 200/数据');
      assert.equal(upstreamConnects, 0, '否决必须发生在上游建连之前');
    } finally { proxy.close(); echo.close(); }
  });

  test('CONNECT 字面内网地址(字符串层) → 直接拒绝', async () => {
    let upstreamConnects = 0;
    const proxy = await startVetoProxy({ lookup: lookupByName({}), connect: opts => { upstreamConnects++; return net.connect(opts); } });
    try {
      const refused = await new Promise(resolve => {
        const c = connectHandshake(proxy.port);
        c.on('connect', () => c.write('CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n'));
        c.on('data', () => { c.destroy(); resolve('got-data'); });
        c.on('error', () => resolve('closed'));
        c.on('close', () => resolve('closed'));
        setTimeout(() => { c.destroy(); resolve('timeout'); }, 5000);
      });
      assert.equal(refused, 'closed');
      assert.equal(upstreamConnects, 0);
    } finally { proxy.close(); }
  });

  test('绝对形式 http: 连接期解析回环 → 502 且源站 0 请求(生产路径, 未注入建连)', async () => {
    let hits = 0;
    const srv = http.createServer((q, s) => { hits++; s.writeHead(200); s.end('page'); });
    await listen(srv);
    const proxy = await startVetoProxy({ lookup: lookupByName({ 'rebind.example.test': LOOPBACK }) });
    try {
      const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { req.destroy(); reject(new Error('代理绝对形式请求超时')); }, 5000);
        const req = http.get({ host: '127.0.0.1', port: proxy.port, path: `http://rebind.example.test:${srv.address().port}/page` }, r => {
          const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => { clearTimeout(timer); resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }); });
        });
        req.on('error', e => { clearTimeout(timer); reject(e); });
      });
      assert.equal(res.status, 502, '回源被否决应回 502');
      assert.equal(hits, 0, '源站一个请求都不能收到');
    } finally { proxy.close(); srv.close(); }
  });

  test('绝对形式 http: 公网名 → 经代理透传, 状态/头/体一致(传输注入假上游)', async () => {
    let hits = 0;
    const srv = http.createServer((q, s) => { hits++; s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html>ok</html>'); });
    await listen(srv);
    const proxy = await startVetoProxy({ lookup: lookupByName({}), connect: connectTo(srv.address().port) });
    try {
      const res = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { req.destroy(); reject(new Error('代理绝对形式请求超时')); }, 5000);
        const req = http.get({ host: '127.0.0.1', port: proxy.port, path: `http://ok.example.test:${srv.address().port}/page` }, r => {
          const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => { clearTimeout(timer); resolve({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(chunks).toString() }); });
        });
        req.on('error', e => { clearTimeout(timer); reject(e); });
      });
      assert.equal(res.status, 200);
      assert.equal(res.type, 'text/html');
      assert.equal(res.body, '<html>ok</html>');
      assert.equal(hits, 1);
    } finally { proxy.close(); srv.close(); }
  });
});

// CLI 的 --url 负向接线(127.0.0.1 字面量 + localtest.me 解析回环)由 review-round2 的既有用例
// 覆盖 —— 它们走的就是换装后的 openUrl→policyGet 路径; 本文件不重复造环境依赖的判据
// (.invalid 之类"必然解析失败"的域名在不同 DNS 环境行为不一, 不作测试依据)。

describe('渲染 Chromium 也必须进否决隧道(第 23 轮收口, 结构钉)', () => {
  test('capture.mjs 的浏览器启动带 proxy(去隧道 = slide 子资源可直连私网, 第 23 轮半做项)', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'capture.mjs'), 'utf8');
    assert.match(src, /startVetoProxy/, 'capture 必须启动否决代理');
    assert.match(src, /proxy:\s*\{\s*server:\s*`http:\/\/127\.0\.0\.1:\$\{veto\.port\}`/, 'launch 必须把浏览器流量收进隧道');
  });
});

describe('浏览器模式接线(带否决代理启动; 需 playwright/chromium, 缺则按能力 skip)', () => {
  test('file:// 页面 --allow-file --list --json 正常列出候选(代理在链上不碍事)', async t => {
    const d = tmpdir();
    // 1×1 PNG: naturalWidth=1, 过滤器(默认 --min 0)必放行
    fs.writeFileSync(path.join(d, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(d, 'page.html'), '<!doctype html><html><body><img src="shot.png" alt="hero"></body></html>');
    const pageUrl = 'file:///' + path.join(d, 'page.html').replace(/\\/g, '/');
    const r = await runSkill('fetch-official-images.mjs', [pageUrl, '--allow-file', '--json'], { cwd: d });
    const out = String(r.stdout + r.stderr);
    if (/未找到 playwright|chromium 未安装|Executable doesn't exist|Looks like Playwright/.test(out)) return t.skip('无 playwright/chromium');
    assert.equal(r.status, 0, out.slice(0, 400));
    assert.match(out, /shot\.png/, '候选里应列出页面图片: ' + out.slice(0, 300));
  });
});

// 七审 blocker 1: 生产 startVetoProxy 的**绝对形式 HTTP** 分支此前不进 host 策略 —— 而
// IP 字面量目标 Node 不调用 lookup, checkedLookup 对它是空转。本地 origin 实测拿到 200 且
// 实收请求。判据钉两件事: ①被拒目标收到 **0 个请求**; ②502 正文点名 blocked-host ——
// 否则"目标不可达"同样表现为 502, 会让断言假绿。
describe('七审 blocker 1 · 生产否决代理: IP 字面量目标 0 请求', () => {
  const viaProxy = (proxyPort, target) => new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: proxyPort, path: target,      // 绝对形式 URL = 代理请求行
      headers: { host: new URL(target).host },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 'ERR', body: e.message }));
    req.end();
  });
  const countingOrigin = async () => {
    const hits = { n: 0 };
    const srv = http.createServer((req, res) => { hits.n++; res.writeHead(200); res.end('SECRET'); });
    await listen(srv);
    return { srv, hits, port: srv.address().port };
  };

  test('loopback 字面量 → 0 请求, 且拒绝来自策略(正文点名 blocked-host)', async () => {
    const { srv, hits, port } = await countingOrigin();
    const proxy = await startVetoProxy({});                  // 生产参数: 不注入 connect/lookup
    try {
      const r = await viaProxy(proxy.port, `http://127.0.0.1:${port}/secret`);
      assert.equal(r.status, 502, r.body);
      assert.match(r.body, /blocked-host/, `拒绝必须来自 host 策略, 实得: ${r.body.slice(0, 200)}`);
      assert.equal(hits.n, 0, '被拒目标必须收到 0 个请求');
    } finally { await proxy.close(); srv.close(); }
  });

  test('私网/元数据/IPv6/零/裸名 字面量 → 全部点名 blocked-host(不可达目标也要证明是策略拦的)', async () => {
    const proxy = await startVetoProxy({});
    try {
      for (const u of ['http://192.168.1.1/admin', 'http://169.254.169.254/latest/meta-data/',
        'http://[::1]:9/x', 'http://0.0.0.0:9/x', 'http://10.0.0.5/internal', 'http://localhost:9/x',
        'http://100.64.0.1/x', 'http://198.18.0.1/x']) {
        const r = await viaProxy(proxy.port, u);
        assert.equal(r.status, 502, `${u} → ${r.status} ${r.body.slice(0, 120)}`);
        assert.match(r.body, /blocked-host/, `${u} 的 502 必须点名 host 策略, 实得: ${r.body.slice(0, 160)}`);
      }
    } finally { await proxy.close(); }
  });

  test('主机名解析回环 → 仍由 checkedLookup 在建连期否决(0 请求, 正文点名 dns-rebinding)', async () => {
    const { srv, hits, port } = await countingOrigin();
    const proxy = await startVetoProxy({ lookup: async () => LOOPBACK });   // 真建连路径
    try {
      const r = await viaProxy(proxy.port, `http://rebind.example.test:${port}/secret`);
      assert.equal(r.status, 502, r.body);
      assert.match(r.body, /dns-rebinding|连接期否决/, r.body.slice(0, 200));
      assert.equal(hits.n, 0, '被拒目标必须收到 0 个请求');
    } finally { await proxy.close(); srv.close(); }
  });

  test('正向对照: 放行的主机名仍能走通绝对形式 HTTP 分支(别把管道焊死)', async () => {
    const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream-ok'); });
    await listen(upstream);
    const upPort = upstream.address().port;
    const proxy = await startVetoProxy({
      lookup: async () => PUB,
      connect: () => net.connect({ host: '127.0.0.1', port: upPort }),   // 假上游: 只换传输
    });
    try {
      const r = await viaProxy(proxy.port, 'http://cdn.example.com/a.png');
      assert.equal(r.status, 200, r.body.slice(0, 200));
      assert.match(r.body, /upstream-ok/);
    } finally { await proxy.close(); upstream.close(); }
  });
});
