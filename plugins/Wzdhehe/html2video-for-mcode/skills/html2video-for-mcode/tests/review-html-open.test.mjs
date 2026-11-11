// PR #41 维护者评审的回归守卫(2026-10-12): 两处"闸门漏过 / 命令行被二次解析"。
//
// 纪律沿用 sec-audit-2026-10-10.test.mjs:
//   · 每个"抓到绕过"的用例都配**合法对照组**, 防"收紧到全报错"这种假修;
//   · 每个"能分辨"的用例都配**检测器自检**, 否则对照组恒绿、证明不了什么;
//   · 先红后绿: 本文件先于修复落地, 红灯记录见评审报告。
//
// 一 · check-slides.mjs 的 CSS 外链闸门: 旧的 cssRegions 只从 **双引号/单引号** 的
//     style 属性里收 CSS, 于是合法的无引号写法 `<div class=stage style=background:url(http://…)>`
//     (维护者的原始复现)整条漏过; 而直接放宽正则又会把 title="style=…" / data-style=…
//     当成真属性(误报)。所以判据必须落在"真标签上真叫 style 的属性"。
// 二 · preview-page.mjs 的 openCmdArgv: Windows 分支把目标路径加引号 + verbatim, 但
//     cmd.exe **在双引号内依然展开 %VAR%**(asr.mjs 对同一边界已 fail closed)。
//     判据是同一条: 引号拦不住变量展开, 只能在 spawn 之前明确拒绝。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { openCmdArgv } from '../scripts/preview-page.mjs';
import { mkproj, runSkill, tmpdir } from './helpers.mjs';

// ─────────────────────────── 问题一 · CSS 外链闸门 ───────────────────────────
describe('PR41 · 行内 style 属性的外链扫描(unquoted / 大写 / 协议相对 / file://)', () => {
  const SLIDE_IDS = [{ id: '01', html: '01.html' }];
  const slide = body => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

  // 真实最小项目: helpers.mkproj 写的是**新鲜** tokens.css(受管区齐全), 免得被 6 号闸门抢先报错
  // —— 否则红灯会来自"tokens 落后"而不是 CSS 外链, 证明不了本组用例在测什么。
  const check = html => {
    const proj = tmpdir();
    mkproj(proj, { slides: SLIDE_IDS });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), html);
    const r = runSkill('check-slides.mjs', [proj], { cwd: proj });
    return { status: r.status, out: String(r.stdout + r.stderr) };
  };

  // 红灯必须来自 CSS 外链闸门本身: 有别的错误抢先报出来, 本用例就失去分辨力。
  const assertCssLinkRejected = html => {
    const { status, out } = check(html);
    assert.equal(status, 1, '外链闸门必须拒绝并退出 1:\n' + out);
    assert.match(out, /CSS 外链/, '应被 CSS 外链闸门点名, 实际输出:\n' + out);
  };

  test('维护者的原始复现: 不带引号的 style 属性也必须进外链扫描', () => {
    assertCssLinkRejected(slide(`<div class=stage style=background:url(http://127.0.0.1/x)>x</div>`));
  });

  test('大写 STYLE + 等号两侧空白(无引号)', () => {
    assertCssLinkRejected(slide(`<div STYLE = background:url(https://cdn.example/z.png)>x</div>`));
  });

  test('协议相对 url(//example.invalid/a.png)', () => {
    assertCssLinkRejected(slide(`<div style=background:url(//example.invalid/a.png)>x</div>`));
  });

  test('file:// 外部资源', () => {
    assertCssLinkRejected(slide(`<div style=background:url(file:///C:/secret/x.png)>x</div>`));
  });

  test('既有能力不许丢: 双引号 / 单引号 / 大写带引号的老写法仍然被拒', () => {
    assertCssLinkRejected(slide(`<div style="background:url(https://cdn.example/d.png)">x</div>`));
    assertCssLinkRejected(slide(`<div style='background:url(https://cdn.example/s.png)'>x</div>`));
    assertCssLinkRejected(slide(`<div STYLE="background:url(https://cdn.example/u.png)">x</div>`));
  });

  test('textarea 开标签上的真 style 属性必须扫描', () => {
    assertCssLinkRejected(slide('<textarea style=background:url(https://example.invalid/x)>正文</textarea>'));
  });

  test('闭合 HTML 注释之后的真 style 仍必须扫描', () => {
    assertCssLinkRejected(slide('<!-- 示例结束 --><div style=background:url(https://example.invalid/x)>x</div>'));
  });

  test('raw-text 内的注释字面量不能遮住后续真标签', () => {
    assertCssLinkRejected(slide(`<script>const example = '<!--';</script><div style=background:url(https://example.invalid/x)>x</div>`));
  });

  test('未闭合 HTML 注释里的示例标签仍只算注释', () => {
    const { status, out } = check(slide('<!-- <div style=background:url(https://example.invalid/x)>示例</div>'));
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /CSS 外链/);
  });

  test('textarea 正文里的示例标签只是文本', () => {
    const { status, out } = check(slide('<textarea><div style=background:url(https://example.invalid/x)>示例</div></textarea>'));
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /CSS 外链/);
  });

  test('script 字符串里的示例标签只是文本', () => {
    const { status, out } = check(slide(`<script>const example = '<div style=background:url(https://example.invalid/x)>';</script>`));
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /CSS 外链/);
  });

  describe('合法对照组: 退出码 0, 且不得把 style= 文本误认成真属性', () => {
    // 四个片段合并成一张: 一旦某个判据过宽(比如"全文搜 style="), 退出码就不再是 0。
    const OK = slide([
      `<div style=opacity:1>ok</div>`,
      `<div data-style=background:url(https://example.invalid/x)>ok</div>`,
      `<div title="style=background:url(https://example.invalid/x)">ok</div>`,
      `<p>正文里的可见链接 https://example.invalid 不算外链</p>`,
      `<!-- 注释里的示例 <div style="background:url(https://example.invalid/c.png)"> 也不是代码 -->`,
    ].join('\n'));

    test('四条合法写法 + 正文链接 + 注释示例, 闸门全绿', () => {
      const { status, out } = check(OK);
      assert.equal(status, 0, '合法对照组必须退出 0, 实际输出:\n' + out);
      assert.ok(!/CSS 外链|外链资源/.test(out), '不应误报外链: ' + out);
    });

    test('检测器自检: 朴素全文正则确实会把 title 里的 style= 当属性(证明对照组有分辨力)', () => {
      const titleTag = `<div title="style=background:url(https://example.invalid/x)">ok</div>`;
      const naive = [...titleTag.matchAll(/(?<![-\w])style\s*=\s*([^\s"'<>`]+)/gi)].map(m => m[1]);
      assert.ok(naive.length > 0,
        '若朴素正则都抓不到, 本对照组证明不了"真属性解析"这条判据; 请先复核测试本身');
      assert.ok(naive.some(v => v.includes('example.invalid')), '朴素正则应命中那段 URL 文本');
    });
  });
});

// ─────────────────────────── 问题二 · Windows --open 的 %VAR% ───────────────────────────
describe('PR41 · openCmdArgv: Windows 下带 % 的路径必须在 spawn 之前 fail closed', () => {
  const IS_WIN = process.platform === 'win32';

  // 纯函数组: 所有平台都跑(用显式 platform 参数, 不依赖运行平台)
  test('Windows: 配对的 %VAR% 与没配对的 % 都拒绝, 错误要能指导下一步', () => {
    for (const bad of ['C:/%TEMP%/index.html', 'C:/a%b/index.html', 'D:/x%/index.html', '%']) {
      assert.throws(() => openCmdArgv(bad, 'win32'), err => {
        assert.match(String(err && err.message), /不能有 %/, '错误要说清是 % 的问题, 实际: ' + (err && err.message));
        assert.match(String(err && err.message), /index\.html|%/);   // 指名道姓给出 offending 路径
        assert.match(String(err && err.message), /手动/, '错误要给出出路(手动打开 / 换目录)');
        return true;
      }, `应拒绝含 % 的路径: ${bad}`);
    }
  });

  test('Windows: 合法路径的既有语义一字不改(start / 空标题字面量 / 引用 / verbatim / &)', () => {
    const plain = openCmdArgv('C:\\work\\proj\\preview\\play\\index.html', 'win32');
    assert.equal(plain.cmd, 'cmd');
    assert.equal(plain.verbatim, true);
    assert.deepEqual(plain.args.slice(0, 2), ['/c', 'start']);
    assert.equal(plain.args[2], '""', 'start 的空标题必须是字面量 ""(verbatim 下空串会消失)');
    assert.equal(plain.args[3], '"C:\\work\\proj\\preview\\play\\index.html"');

    // 路径自带双引号 → 双写后整体再包一层
    const quoted = openCmdArgv('C:\\a"b\\index.html', 'win32');
    assert.equal(quoted.args[3], '"C:\\a""b\\index.html"');
    assert.equal(quoted.verbatim, true);

    // & 是 cmd 控制符: Windows 路径允许含 & 而不含空格, 必须照样整段引用(M1 已定的语义)
    const amp = openCmdArgv('C:\\work&calc\\index.html', 'win32');
    assert.equal(amp.args[3], '"C:\\work&calc\\index.html"');
    assert.equal(amp.args.length, 4);
  });

  test('非 Windows: 没有 cmd 边界, 含 % 的路径原样返回, 不误伤', () => {
    const mac = openCmdArgv('/tmp/100%/index.html', 'darwin');
    assert.deepEqual(mac, { cmd: 'open', args: ['/tmp/100%/index.html'], verbatim: false });
    const lin = openCmdArgv('/tmp/%TEMP%/index.html', 'linux');
    assert.deepEqual(lin, { cmd: 'xdg-open', args: ['/tmp/%TEMP%/index.html'], verbatim: false });
  });

  // 行为证明: 只证明"引号内照样展开"这一件事, 不拉起浏览器/可见窗口(cmd /c + echo, 无副作用)。
  test('行为证明: 引号包住的 %VAR% 确实被 cmd 展开(对照: 生产 helper 先拒绝同一条路径)',
    { skip: !IS_WIN && 'Windows 专属(cmd 语义)' }, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr41-open-'));
      const marker = path.join(tmp, 'MARKER.txt').split(path.sep).join('/');
      const target = `C:/%PR41_MARKER%/${path.basename(tmp)}/index.html`;   // 子进程专用变量, 不碰真实环境
      // 用生产同款形状: verbatim + 引号由我们自己补(这里把 start 换成 echo, 免得真开浏览器)
      const echoed = spawnSync('cmd', ['/c', 'echo', `"${target}"`], {
        encoding: 'utf8', windowsHide: true, env: { ...process.env, PR41_MARKER: marker },
        windowsVerbatimArguments: true, timeout: 20000,
      });
      const seen = String(echoed.stdout ?? '');
      assert.ok(seen.includes(marker),
        `引号内的 %PR41_MARKER% 应被展开成真实值, 实际 stdout=${JSON.stringify(seen)}`);
      assert.ok(!seen.includes('%PR41_MARKER%'), '展开后不应再看到字面量变量名');

      // 同一路径送进生产 helper: 必须先拒绝(spawn 之前), 而不是打开一个错文件
      assert.throws(() => openCmdArgv(target, 'win32'), /不能有 %/);
      fs.rmSync(tmp, { recursive: true, force: true });
    });
});
