// html2video-for-mcode · 测试共用件(文件名不匹配 *.test.mjs, 不会被 node --test 当作用例执行)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wrapTokens } from '../scripts/css-kit.mjs';
import { generateTokensCss, TOKENS_REV } from '../scripts/tokens-template.mjs';

export const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
export const skill = name => path.join(SCRIPTS, name);

// 跑一个技能脚本, 返回 { status, stdout, stderr }
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
export const runSkill = (name, args, opts = {}) => run(process.execPath, [skill(name), ...args], opts);

// 异步版: 子进程与父进程需要并发交互时必须用这个 —— spawnSync 会冻结事件循环,
// 父进程里的本地服务器 accept 不了子进程的连接, 互相等死(本次实测踩过)
import { spawn } from 'node:child_process';
export function runSkillAsync(name, args, opts = {}) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [skill(name), ...args], { windowsHide: true, ...opts });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('error', err => resolve({ status: -1, stdout, stderr: stderr + String(err) }));
    c.on('close', status => resolve({ status, stdout, stderr }));
  });
}

// 临时目录(进程退出时统一清理 —— 此前上万个 h2v-test-* 堆在 %TEMP%, 第八轮复查 F2)
const madeDirs = new Set();
export const tmpdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'h2v-test-'));
  madeDirs.add(d);
  return d;
};
process.once('exit', () => { for (const d of madeDirs) fs.rmSync(d, { recursive: true, force: true }); });

// 在 subprocess 里调用 tools.mjs 的退出型助手(safeId/safeRel 会 process.exit, 只能这样测)
export function probeHelper(expr, argsJson) {
  const code = `
    import { ${expr} } from ${JSON.stringify(pathToFileURL(skill('tools.mjs')).href)};
    const args = ${argsJson};
    const v = ${expr}(...args);
    process.stdout.write('RETURN:' + String(v));
  `;
  return run(process.execPath, ['--input-type=module', '-e', code]);
}

// 最小可跑的项目骨架(check-slides 需要 tokens.css; 其余脚本按需补)
// tokens.css 默认写成**真项目的样子**: 项目自己的规则 + 技能当前的受管区。2026-09-18 起
// check-slides / capture / build-video 把"受管区缺失或落后"当阻断级(旧 CSS 会静默出片),
// 所以默认骨架要是新鲜的 —— 要测"落后/无受管区"的场景, 显式传 tokens 或 LEGACY_TOKENS。
export const FRESH_TOKENS = ':root { --accent: #111; }\n' + wrapTokens(generateTokensCss(), TOKENS_REV) + '\n';
export const LEGACY_TOKENS = ':root { --accent: #111; }\n';   // 老项目形状: 没有受管区
export function mkproj(dir, { slides = [], tokens = FRESH_TOKENS } = {}) {
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'slides', 'tokens.css'), tokens);
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({
    topic: 't', fps: 30, width: 1920, height: 1080, slides,
  }, null, 2));
  return dir;
}
