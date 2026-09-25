// screenshot.mjs
//
// Take a screenshot using the platform-specific CLI tool detected by
// platform.mjs. Returns PNG bytes (Buffer).

import { spawnSync } from 'node:child_process';
import { writeFile, readFile, unlink, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpPng() {
  const dir = mkdtempSync(join(tmpdir(), 'mcode-cu-'));
  return join(dir, `screen-${process.pid}-${Date.now()}.png`);
}

async function captureMacos(plan, region, monitor) {
  const file = tmpPng();
  const args = ['-x', '-t', 'png'];
  if (region) {
    const [x0, y0, x1, y1] = region;
    args.push('-R', `${x0},${y0},${x1 - x0},${y1 - y0}`);
  }
  if (typeof monitor === 'number') args.push('-l', String(monitor));
  args.push(file);
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`screencapture failed: ${r.stderr || r.stdout}`);
  }
  return await readFileP(file);
}

async function captureGrim(plan, region) {
  const file = tmpPng();
  const args = [];
  if (region) {
    args.push('-g', `${region[0]},${region[1]},${region[2] - region[0]},${region[3] - region[1]}`);
  }
  args.push(file);
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${plan.screenshot.bin} failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

async function captureScrot(plan, region) {
  const file = tmpPng();
  const args = [];
  if (region) {
    args.push('-a', `${region[0]},${region[1]},${region[2] - region[0]},${region[3] - region[1]}`);
  }
  args.push(file);
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${plan.screenshot.bin} failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

async function captureGnomeScreenshot(plan) {
  const file = tmpPng();
  const args = ['-f', file];
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${plan.screenshot.bin} failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

async function captureImport(plan, region) {
  const file = tmpPng();
  const args = ['-window', 'root'];
  if (region) {
    args.push('-crop', `${region[2] - region[0]}x${region[3] - region[1]}+${region[0]}+${region[1]}`);
  }
  args.push(file);
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${plan.screenshot.bin} failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

async function captureSpectacle(plan) {
  const file = tmpPng();
  const args = ['-b', '-n', '-o', file];
  const r = spawnSync(plan.screenshot.bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`spectacle failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

const PS_SCREENSHOT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('OUT_PATH', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;

async function captureWindows(plan) {
  const file = tmpPng();
  const script = PS_SCREENSHOT.replace('OUT_PATH', file.replace(/\\/g, '\\\\'));
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`PowerShell screenshot failed: ${r.stderr || r.stdout}`);
  return await readFileP(file);
}

function readFileP(file) {
  const data = readFileSync(file);
  try { unlinkSync(file); } catch {}
  return Promise.resolve(data);
}

// Tiny helper that uses sync read+unlink (sync read is fine for small PNGs).
import { readFileSync, unlinkSync } from 'node:fs';

export async function takeScreenshot(plan, { region, monitor } = {}) {
  if (!plan.ready) {
    const err = new Error(`computer-use: required tools missing on ${plan.os}`);
    err.code = 'TOOLS_MISSING';
    err.hint = plan.needs.join('; ');
    throw err;
  }
  const k = plan.screenshot.kind;
  if (plan.os === 'macos') return captureMacos(plan, region, monitor);
  if (k === 'grim')         return captureGrim(plan, region);
  if (k === 'scrot')        return captureScrot(plan, region);
  if (k === 'gnome-screenshot') return captureGnomeScreenshot(plan);
  if (k === 'import')       return captureImport(plan, region);
  if (k === 'spectacle')    return captureSpectacle(plan);
  if (plan.os === 'windows') return captureWindows(plan);
  throw new Error(`unsupported screenshot kind ${k}`);
}
