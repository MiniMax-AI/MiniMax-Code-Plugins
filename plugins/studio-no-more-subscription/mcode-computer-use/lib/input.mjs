// input.mjs
//
// Inject mouse and keyboard events using the platform-specific CLI tool.

import { spawnSync } from 'node:child_process';

export async function click(plan, x, y, { button = 'left', modifiers = [] } = {}) {
  if (!plan.ready) {
    const err = new Error('computer-use: input tools not ready');
    err.code = 'TOOLS_MISSING';
    err.hint = plan.needs.join('; ');
    throw err;
  }
  const k = plan.input.kind;
  if (k === 'cliclick') {
    // cliclick p:<x>,<y> ... ; buttons: c: left, t: right, m: middle.
    const btn = button === 'left' ? 'c' : button === 'right' ? 't' : 'm';
    const r = spawnSync('cliclick', [`p:${x},${y}`, `m:${x},${y}`, `${btn}:${x},${y}`],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cliclick failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'xdotool') {
    const mod = modifiersToXdotool(modifiers);
    const btn = button === 'left' ? 1 : button === 'right' ? 3 : 2;
    const r = spawnSync('xdotool', [...mod, 'mousemove', '--sync', String(x), String(y), 'click', String(btn)],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`xdotool click failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'ydotool') {
    // ydotool uses --button 0x110=left, 0x111=right, 0x112=middle (BTN_MOUSE).
    const btn = button === 'left' ? '0x110' : button === 'right' ? '0x111' : '0x112';
    const r = spawnSync('ydotool', ['mousemove', '-a', '-x', String(x), '-y', String(y), 'click', btn],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ydotool click failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'powershell-sendinput') {
    // PowerShell SendInput via .NET. We translate a single click.
    const btnFlag = button === 'left' ? 0x0002 : button === 'right' ? 0x0008 : 0x0020;
    const downFlag = btnFlag;
    const upFlag = btnFlag * 2; // MOUSEEVENTF_LEFTUP = 0x0004 for left, etc.
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int dw, IntPtr ext);
}
"@
[W]::SetCursorPos(${x}, ${y})
[W]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
[W]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`PowerShell click failed: ${r.stderr || r.stdout}`);
    return;
  }
  throw new Error(`unsupported input kind ${k}`);
}

export async function scroll(plan, x, y, dx, dy) {
  if (!plan.ready) {
    const err = new Error('computer-use: input tools not ready');
    err.code = 'TOOLS_MISSING';
    throw err;
  }
  const k = plan.input.kind;
  if (k === 'cliclick') {
    // cliclick wheel events: there's no direct wheel; simulate via arrow keys
    // or skip on platforms without it. For minimal support we run an AppleScript.
    // However, cliclick does NOT support wheel; we use osascript fallback.
    const r = spawnSync('osascript', ['-e',
      `tell application "System Events" to scroll {x:${x}, y:${y}} by ${dy}`],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`osascript scroll failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'xdotool') {
    const button = dy > 0 ? 5 : (dy < 0 ? 4 : (dx > 0 ? 7 : 6));
    const r = spawnSync('xdotool', ['mousemove', '--sync', String(x), String(y),
      'click', String(button)],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`xdotool scroll failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'ydotool') {
    // ydotool doesn't model scroll directly; emulate with keyboard arrows for vertical.
    // For simplicity we run a sequence of PageUp/PageDown if dy != 0.
    if (dy !== 0) {
      const key = dy > 0 ? 'PageDown' : 'PageUp';
      const steps = Math.min(Math.abs(dy), 20);
      for (let i = 0; i < steps; i += 1) {
        spawnSync('ydotool', ['key', key], { encoding: 'utf8' });
      }
    }
    return;
  }
  if (k === 'powershell-sendinput') {
    // WHEEL_DELTA = 120, positive = up
    const delta = -dy * 120;
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int dw, IntPtr ext);
}
"@
[W2]::SetCursorPos(${x}, ${y})
[W2]::mouse_event(0x0800, 0, 0, ${delta}, [IntPtr]::Zero)
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`PowerShell scroll failed: ${r.stderr || r.stdout}`);
    return;
  }
  throw new Error(`unsupported input kind ${k}`);
}

export async function drag(plan, from, to, { button = 'left' } = {}) {
  const k = plan.input.kind;
  if (k === 'xdotool') {
    const btn = button === 'left' ? 1 : button === 'right' ? 3 : 2;
    const r = spawnSync('xdotool', ['mousemove', '--sync', String(from[0]), String(from[1]),
      'mousedown', String(btn),
      'mousemove', '--sync', String(to[0]), String(to[1]),
      'mouseup', String(btn)],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`xdotool drag failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'cliclick') {
    const btn = button === 'left' ? 'c' : button === 'right' ? 't' : 'm';
    const r = spawnSync('cliclick',
      [`dd:${btn}`, `m:${from[0]},${from[1]}`, `du:${btn}`, `m:${to[0]},${to[1]}`],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cliclick drag failed: ${r.stderr || r.stdout}`);
    return;
  }
  // Fallback: sequence of move + click.
  await click(plan, from[0], from[1], { button });
  await new Promise((r) => setTimeout(r, 50));
  await click(plan, to[0], to[1], { button });
}

export async function typeText(plan, text, { intervalMs = 0 } = {}) {
  const k = plan.input.kind;
  if (k === 'xdotool') {
    // xdotool type handles unicode but special chars need a window id; default is fine.
    const r = spawnSync('xdotool', ['type', '--delay', String(intervalMs), '--clearmodifiers', text],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`xdotool type failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'cliclick') {
    // cliclick t:"text" types a string. Newlines and tabs need escape.
    const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = spawnSync('cliclick', [`t:"${safe}"`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cliclick type failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'powershell-sendinput') {
    // Use SendInput with virtual keys; basic printable chars only.
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($([char]34) + ('${text.replace(/'/g, "''")}' ) + $([char]34))
`;
    // Actually simpler: pipe the text via clipboard + Ctrl+V
    const clip = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText('${text.replace(/'/g, "''")}')
`;
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', clip],
      { encoding: 'utf8' });
    await keyCombo(plan, ['ctrl', 'v']);
    return;
  }
  throw new Error(`unsupported input kind ${k}`);
}

export async function keyCombo(plan, keys) {
  const k = plan.input.kind;
  if (k === 'xdotool') {
    const r = spawnSync('xdotool', ['key', keys.join('+')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`xdotool key failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'cliclick') {
    // cliclick uses key names like "tab", "enter", "f1"... limited chord support.
    const r = spawnSync('cliclick', ['kp:' + keys.join('-')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cliclick key failed: ${r.stderr || r.stdout}`);
    return;
  }
  if (k === 'powershell-sendinput') {
    const map = {
      ctrl: '^', alt: '%', shift: '+', cmd: '^',
      enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
      backspace: '{BS}', delete: '{DEL}', space: ' ',
      up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
      home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
    };
    const seq = keys.map((k2) => map[k2.toLowerCase()] || k2).join('');
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`PowerShell key failed: ${r.stderr || r.stdout}`);
    return;
  }
  throw new Error(`unsupported input kind ${k}`);
}

export async function cursorPosition(plan) {
  const k = plan.input.kind;
  if (k === 'xdotool') {
    const r = spawnSync('xdotool', ['getmouselocation', '--shell'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const out = {};
    for (const line of r.stdout.split('\n')) {
      const [k2, v] = line.split('=');
      if (k2 && v) out[k2.trim()] = Number(v);
    }
    return out;
  }
  if (k === 'cliclick') {
    const r = spawnSync('cliclick', ['p'], { encoding: 'utf8' });
    // Output looks like "123,456" or "error: ..."
    if (r.status !== 0) return null;
    const m = r.stdout.trim().match(/(-?\d+),(-?\d+)/);
    if (m) return { X: Number(m[1]), Y: Number(m[2]) };
    return null;
  }
  if (k === 'powershell-sendinput') {
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W3 {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
}
"@
$p = New-Object W3+P
[W3]::GetCursorPos([ref]$p) | Out-Null
"X=$($p.X) Y=$($p.Y)"
`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const out = {};
    for (const part of r.stdout.trim().split(/\s+/)) {
      const [k2, v] = part.split('=');
      if (k2 && v) out[k2.trim()] = Number(v);
    }
    return out;
  }
  return null;
}

function modifiersToXdotool(modifiers) {
  const out = [];
  for (const m of modifiers) {
    const l = m.toLowerCase();
    if (l === 'ctrl' || l === 'control') out.push('ctrl');
    else if (l === 'alt' || l === 'option') out.push('alt');
    else if (l === 'shift') out.push('shift');
    else if (l === 'super' || l === 'cmd' || l === 'meta' || l === 'win') out.push('super');
  }
  return out;
}
