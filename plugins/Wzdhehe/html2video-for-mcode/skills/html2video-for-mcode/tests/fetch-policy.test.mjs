// 安全边界 · 抓图 URL 策略(SSRF / 本地文件读 / 重定向 / 文件名)
// 对应评审意见 4: SSRF and local-file-read behavior in fetch-official-images.mjs。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlockedHost, assertFetchableUrl, assertRedirectTarget, sanitizeFilename, MAX_REDIRECTS, PolicyError,
} from '../scripts/url-policy.mjs';

describe('isBlockedHost(内网/本地/元数据/裸主机名)', () => {
  const blocked = [
    '127.0.0.1', '127.8.9.10',            // loopback
    '169.254.169.254', '169.254.0.9',     // 链路本地(含云元数据)
    '10.0.0.5', '172.16.0.1', '172.31.9.9', '192.168.1.1', // 私网
    '100.64.0.1',                          // CGNAT
    '0.0.0.0',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', // IPv6 loopback/链路本地/ULA
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', // IPv4-mapped
    'localhost', 'intranet-app',           // 无点主机名
    'box.local', 'corp.internal', 'x.home.arpa',
    '',                                    // 空
  ];
  const allowed = [
    '8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', // 公网(含私网段边界外)
    'api.minimaxi.com', 'example.com', 'cdn.example.co.uk',
    '::ffff:8.8.8.8', '2606:4700::1111',
  ];
  for (const h of blocked) test(`拦 ${h}`, () => assert.equal(isBlockedHost(h), true, h));
  for (const h of allowed) test(`放 ${h}`, () => assert.equal(isBlockedHost(h), false, h));
});

describe('assertFetchableUrl', () => {
  test('公网 https/http 放行', () => {
    assertFetchableUrl('https://example.com/a.png');
    assertFetchableUrl('http://example.com/a.png');
  });
  test('内网/元数据/裸名拒绝', () => {
    for (const u of ['https://127.0.0.1/x', 'http://169.254.169.254/latest', 'https://192.168.0.1/', 'http://localhost/', 'http://intranet/x']) {
      assert.throws(() => assertFetchableUrl(u), PolicyError, u);
    }
  });
  test('file:// 默认拒绝, --allow-file 放行', () => {
    assert.throws(() => assertFetchableUrl('file:///C:/page.html'), PolicyError);
    assertFetchableUrl('file:///C:/page.html', { allowFile: true });
  });
  test('带 userinfo 的 URL 拒绝(凭据会泄漏进日志)', () => {
    assert.throws(() => assertFetchableUrl('https://user:pw@example.com/a.png'), PolicyError);
  });
  test('非 http(s)/file 协议拒绝', () => {
    for (const u of ['ftp://example.com/a', 'javascript:alert(1)', 'data:text/html,x']) {
      assert.throws(() => assertFetchableUrl(u), PolicyError, u);
    }
  });
});

describe('重定向目标逐跳校验', () => {
  test('重定向到私网/元数据/file: 拒绝', () => {
    for (const loc of ['http://10.0.0.5/x.png', 'http://169.254.169.254/a', 'file:///C:/Windows/win.ini', 'https://evil.example']) {
      if (loc === 'https://evil.example') continue; // 公网第三方在抓图语境是允许的(offsite 仅标注)
      assert.throws(() => assertRedirectTarget(loc), PolicyError, loc);
    }
  });
  test('重定向到公网放行; MAX_REDIRECTS 有上限', () => {
    assertRedirectTarget('https://cdn.example.com/a.png');
    assert.equal(typeof MAX_REDIRECTS, 'number');
    assert.ok(MAX_REDIRECTS >= 1 && MAX_REDIRECTS <= 10, '重定向上限应在 1–10 跳');
  });
});

describe('sanitizeFilename(页面控制的 alt → 落盘名)', () => {
  test('路径分隔符与控制字符被替换', () => {
    const n = sanitizeFilename('brand/logo\\main v2');
    assert.ok(!n.includes('/') && !n.includes('\\'), n);
  });
  test('Windows 保留名被替换', () => {
    for (const bad of ['CON', 'con', 'NUL', 'com1', 'LPT9']) {
      assert.ok(sanitizeFilename(bad) !== bad, `保留名 ${bad} 必须被换掉`);
    }
  });
  test('开头点/空格被剥(不产生隐藏文件)', () => {
    assert.ok(!sanitizeFilename('  .hidden').startsWith('.'), sanitizeFilename('  .hidden'));
  });
  test('空/undefined → fallback', () => {
    assert.equal(sanitizeFilename(''), 'official');
    assert.equal(sanitizeFilename(undefined), 'official');
  });
  test('长度有上限', () => {
    assert.ok(sanitizeFilename('x'.repeat(500)).length <= 30);
  });
});
