// 2026-10-10 独立安全审计的守卫(解析与生成这一维, 前七轮维护者评审未覆盖)。
// 判据原则(沿用本仓既有纪律):
//   · H1 的检测必须**解析属性名**而不是搜 `on*=` 文本 —— 修复后文本仍在属性值里, 文本搜索会假红;
//     所以每个"抓到注入"的用例都配一个检测器自检(未转义的形态必须被认出), 否则整组恒绿。
//   · H2 的不变量是"行首时间码数 == cue 数"(SRT 的结构边界), 不是全文 "-->" 计数。
//   · 闸门类(M2/M3/M4)每个绕过用例都配一个合法对照组, 防"收紧到全报错"这种假修。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { addNoFx, injectHtmlVars } from '../scripts/preview-page.mjs';
import { assertConcatPathSafe, buildSrt, sanitizeCaptionText, stripControlChars } from '../scripts/tools.mjs';
import { isBlockedHost } from '../scripts/url-policy.mjs';
import { mkproj, runSkill, tmpdir } from './helpers.mjs';

// ── 属性解析器(判据的基础: 尊重引号) ────────────────────────────────
function attrsOf(tag) {
  const body = tag.replace(/^<\s*[a-zA-Z][\w:-]*/, '').replace(/\/?>$/, '');
  const attrs = [];
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const s = i;
    while (i < body.length && !/[\s=]/.test(body[i])) i++;
    if (i === s) break;
    const name = body.slice(s, i);
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '=') { attrs.push({ name, value: null }); continue; }
    i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    let value;
    if (body[i] === '"' || body[i] === "'") {
      const q = body[i++], end = body.indexOf(q, i);
      if (end < 0) return { malformed: true, attrs };
      value = body.slice(i, end); i = end + 1;
    } else {
      const vs = i;
      while (i < body.length && !/\s/.test(body[i])) i++;
      value = body.slice(vs, i);
    }
    attrs.push({ name, value });
  }
  return { malformed: false, attrs };
}
const htmlTag = html => /<html\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(html)?.[0] ?? '';
const handlersIn = html => attrsOf(htmlTag(html)).attrs.filter(a => /^on/i.test(a.name));

describe('H1 · 放映页属性注入: 重新序列化前必须转义', () => {
  test('addNoFx: 单引号值里的 " 不能闭合属性并追加 on* 处理器', () => {
    const out = addNoFx(`<html class='x" onmouseover=window.FIRED=1 data-x='><head><title>t</title></head><body></body></html>`);
    assert.deepEqual(handlersIn(out), [], '注入的事件处理器: ' + JSON.stringify(attrsOf(htmlTag(out)).attrs));
    const cls = attrsOf(htmlTag(out)).attrs.find(a => a.name === 'class');
    assert.match(cls.value, /no-fx/, 'no-fx 仍要加上');
    assert.match(cls.value, /&quot;/, '引号应被转义成实体, 而不是原样闭合属性');
  });
  test('injectHtmlVars: 同样的注入形态(style 属性)', () => {
    const out = injectHtmlVars(`<html style='--t2:800ms" onload=window.FIRED=1 data-x='><head></head></html>`, '--t1:400ms');
    assert.deepEqual(handlersIn(out), [], '注入的事件处理器: ' + htmlTag(out));
    assert.match(attrsOf(htmlTag(out)).attrs.find(a => a.name === 'style').value, /--t1:400ms/);
  });
  test('检测器自检: 未转义的形态必须被认出来(否则上面两条是恒绿)', () => {
    const raw = attrsOf('<html class="x" onmouseover=window.FIRED=1 data-x=" no-fx">');
    assert.ok(raw.attrs.some(a => /^on/i.test(a.name)), '未转义形态应被解析出 on* 属性');
  });
  test('data-style / data-class 不得遮蔽真属性(L3)', () => {
    const out = injectHtmlVars(`<html data-style="--t2:9999ms" style="--t2:800ms"><head></head></html>`, '--t1:400ms');
    const style = attrsOf(htmlTag(out)).attrs.find(a => a.name === 'style');
    assert.ok(style, '真 style 属性必须还在');
    assert.match(style.value, /--t2:800ms/, '真 style 必须保留');
    assert.match(style.value, /--t1:400ms/, '注入值必须挂到真 style 上');
  });
  test('注释里的 <html> 是诱饵: 改真标签, 不改注释(L3)', () => {
    const out = addNoFx(`<!doctype html><html><head><!-- <html class='decoy'> --><title>t</title></head><body><h1>1</h1></body></html>`);
    const real = /<html\b[^>]*>/i.exec(out.slice(out.indexOf('<html>', 5) > -1 ? out.indexOf('>', out.indexOf('<html>', 5)) + 1 : 0))?.[0] ?? '';
    assert.match(real, /class="[^"]*no-fx/, `真 <html> 应被加上 no-fx, 实际: ${out}`);
    assert.match(out, /<!-- <html class='decoy'> -->/, '注释内容不该被改写');
  });
  test('属性值里的 > 不该把标签截断(L3)', () => {
    const out = injectHtmlVars(`<html style="--x: calc(1 > 0)" data-k="v"><head></head></html>`, '--t1:400ms');
    assert.match(htmlTag(out), /data-k="v"/, `标签应完整读到 data-k, 实际: ${htmlTag(out)}`);
  });
});

describe('H2 · SRT: clause 文本不得伪造 cue 结构', () => {
  const TC = /^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/;
  test('注入的时间码行只是单行文本, 行首时间码数仍等于 cue 数', () => {
    const { text, count } = buildSrt({ slides: [{ duration: 10, clauses: [
      { start: 0, text: 'benign\n\n99\n00:59:00,000 --> 01:00:00,000\nFORGED' },
      { start: 5, text: 'second' },
    ] }] });
    const lines = text.split('\n');
    assert.equal(lines.filter(l => TC.test(l)).length, count, '行首时间码数必须等于 cue 数');
    assert.ok(!lines.some(l => /-->/.test(l) && !TC.test(l)), '不应有"含 --> 但不是合法 cue 头"的行');
  });
  test('sanitizeCaptionText: 换行折平 / 控制字符与 bidi 剔除 / --&gt; 中和 / 空白折叠', () => {
    assert.equal(sanitizeCaptionText('a\r\nb'), 'a b');
    assert.equal(sanitizeCaptionText('a\n\n\nb'), 'a b');
    assert.equal(sanitizeCaptionText('a\u0007\u001b[31m b'), 'a[31m b');
    assert.equal(sanitizeCaptionText('IMDb\u202Etest'), 'IMDbtest');
    assert.equal(sanitizeCaptionText('x --> y'), 'x → y');
    assert.equal(sanitizeCaptionText('\n\n'), '');
    assert.equal(sanitizeCaptionText('x'.repeat(500)).length, 400);
  });
  test('双语行仍保留(净化不许吃掉正常内容)', () => {
    const { text, count } = buildSrt({ slides: [{ duration: 4, clauses: [{ start: 0, text: '主行', text2: 'second line' }] }] });
    assert.equal(count, 1);
    assert.match(text, /主行\nsecond line/);
  });
});

describe('M1 · --open 打开浏览器的命令行不得起第二条命令(Windows)', () => {
  const isWin = process.platform === 'win32';
  test('显式引用后 & 不再是命令分隔符; 未引用则确实会被执行', { skip: !isWin && 'Windows 专属(cmd 语义)' }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-'));
    const marker = path.join(tmp, 'MARKER.txt');
    const target = `C:/a>${marker.split(path.sep).join('/')}&rem`;
    const run = (quoted, verbatim) => new Promise(resolve => {
      // 注意: 参数必须是**表达式**而不是 `const args = [...]` 声明 —— 声明塞进调用里
      // 会让子进程语法错误、命令根本没执行, 于是"未引用也不建 marker"的假绿就是这么来的。
      const argsExpr = quoted
        ? `['/c','echo','', '"' + target + '"']`
        : `['/c','echo','', target]`;
      const opts = verbatim ? `, windowsVerbatimArguments: true` : '';
      const code = `import { spawn } from 'node:child_process';
        const target = ${JSON.stringify(target)};
        await new Promise(r => { const p = spawn('cmd', ${argsExpr}, { windowsHide: true${opts} });
          p.stdout.on('data',()=>{}); p.on('close',()=>r()); p.on('error',()=>r()); });`;
      spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      resolve(fs.existsSync(marker));
    });
    const createdQuoted = await run(true, true);
    assert.equal(createdQuoted, false, '显式引用后不得创建第二条命令的产物');
    const createdUnquoted = await run(false, false);
    assert.equal(createdUnquoted, true, '对照组: 未引用时确实会执行(证明本用例会分辨)');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('M2/M3/M4 · 三条闸门绕过 + 合法对照组', () => {
  const slide = body => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  const check = (html, extra = () => {}) => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), html);
    extra(proj);
    const r = runSkill('check-slides.mjs', [proj], { cwd: proj });
    return String(r.stdout + r.stderr);
  };
  const slideId = [{ id: '01', html: '01.html' }];

  test('M2: 只借 fx- 前缀的假类被点名', () => {
    assert.match(check(slide(`<div class="fx-notreal" data-stage="1">x</div>`)), /fx 类没有对应动画声明/);
  });
  test('M2: 本张 <style> 里自定义 fx 类的关键帧缺 opacity 被点名(tokens.css 之外的本地类也查)', () => {
    assert.match(check(slide(`<style>.fx-mine{animation:k-mine .6s}@keyframes k-mine{from{transform:scale(.9)}to{transform:scale(1)}}</style><div class="fx-mine" data-stage="1">x</div>`)), /没声明 opacity/);
  });
  test('M3: 注释里的 --var 不能充当定义', () => {
    assert.match(check(slide(`<p style="color:var(--c-fake)">x</p><!-- --c-fake: 1 -->`)), /未定义且无 fallback/);
  });
  test('M4: 大写 SRC= / 协议相对 / @import / CSS url() 都被点名', () => {
    assert.match(check(slide(`<IMG SRC=https://evil.example/x.png>`)), /外链资源/);
    assert.match(check(slide(`<img src="//host.example/x.png">`)), /外链资源/);
    assert.match(check(slide(`<style>@import url(https://cdn.example/x.css);</style>`)), /CSS 外链/);
    assert.match(check(slide(`<div style="background:url(https://cdn.example/y.png)">x</div>`)), /CSS 外链/);
  });
  test('对照组: 合法幻灯片零误报(含正文里的可见链接与真实 fx 类)', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: slideId });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), slide(`<div class="fx-up" data-stage="1">标题</div><p>见 https://example.com 说明</p>`));
    fs.writeFileSync(path.join(proj, 'slides', 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const r = runSkill('check-slides.mjs', [proj], { cwd: proj });
    const out = String(r.stdout + r.stderr);
    assert.equal(r.status, 0, out);
    assert.ok(!/外链资源|CSS 外链|fx 类没有对应动画声明|未定义且无 fallback/.test(out), '不应误报: ' + out);
  });
});

describe('LOW · L1/L5/L6 与控制字符', () => {
  test('L1: slides/ 下的链接指向项目外 → 图片闸门按真实路径判越界(建不了链接则 skip)', (t) => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html' }] });
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, 'secret.png'), 'x');
    const link = path.join(proj, 'slides', 'assets-link');
    let made = false;
    try { fs.symlinkSync(outside, link, 'dir'); made = true; } catch {
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8', windowsHide: true });
      made = r.status === 0 && fs.existsSync(link);
    }
    if (!made) return t.skip('当前环境建不了符号链接/junction');
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), `<!doctype html><html><head></head><body><img src="assets-link/secret.png" alt="x"></body></html>`);
    const r = runSkill('check-slides.mjs', [proj], { cwd: proj });
    const out = String(r.stdout + r.stderr);
    assert.notEqual(r.status, 0, '经链接指向项目外必须报错');
    assert.match(out, /越出项目目录|指向项目外/);
  });
  test('L5: 展开写法的 IPv4-mapped IPv6(0:0:0:0:0:ffff:7f00:1)也判为被拦', () => {
    assert.equal(net.isIP('0:0:0:0:0:ffff:7f00:1'), 6, '前置: 这是合法 IPv6 文本');
    assert.equal(isBlockedHost('0:0:0:0:0:ffff:7f00:1'), true);
    assert.equal(isBlockedHost('0:0:0:0:0:ffff:a9fe:a9fe'), true, '元数据地址的展开写法同样要拦');
  });
  test('L6: concat 列表的路径守卫(单引号/换行 → 明确失败)', () => {
    assert.equal(assertConcatPathSafe('C:/ok/path.mp4'), 'C:/ok/path.mp4');
    assert.throws(() => assertConcatPathSafe("C:/it's/x.mp4"), /不能有单引号或换行/);
    assert.throws(() => assertConcatPathSafe('C:/x\ny.mp4'), /不能有单引号或换行/);
  });
  test('L4: stripControlChars 剔除控制字符与 bidi, 保留普通内容', () => {
    assert.equal(stripControlChars('a\u0007\u001b[0m\u202Eb'), 'a[0mb');
    assert.equal(stripControlChars('正常 文本\r\n第二行'), '正常 文本\n第二行');
    assert.equal(stripControlChars('纯 ASCII'), '纯 ASCII');
  });
});