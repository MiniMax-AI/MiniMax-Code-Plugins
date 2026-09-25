// platform.mjs
//
// Detects the host OS and reports which external CLI tools the plugin
// needs. Also performs a one-time `which`-style probe at session start so
// we fail fast with a friendly message if anything is missing.

import { spawnSync } from 'node:child_process';

export const HOST_OS = (() => {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'linux':  return 'linux';
    case 'win32':  return 'windows';
    default:       return process.platform;
  }
})();

function which(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [bin], { encoding: 'utf8' });
  return r.status === 0;
}

// Pick the best screenshot tool available on Linux.
// Order: grim (Wayland) > scrot > gnome-screenshot > import > spectacle.
function pickLinuxScreenshot() {
  if (which('grim')) return 'grim';
  if (which('scrot')) return 'scrot';
  if (which('gnome-screenshot')) return 'gnome-screenshot';
  if (which('import')) return 'import';
  if (which('spectacle')) return 'spectacle';
  return null;
}

function pickLinuxInput() {
  if (which('xdotool')) return 'xdotool';
  if (which('ydotool')) return 'ydotool';
  return null;
}

export function detect() {
  const plan = {
    os: HOST_OS,
    screenshot: null,
    input: null,
    needs: [],
  };
  if (HOST_OS === 'macos') {
    plan.screenshot = { kind: 'builtin', bin: 'screencapture' };
    if (which('cliclick')) {
      plan.input = { kind: 'cliclick', bin: 'cliclick' };
    } else {
      plan.input = null;
      plan.needs.push('cliclick (brew install cliclick)');
    }
  } else if (HOST_OS === 'linux') {
    const ss = pickLinuxScreenshot();
    if (ss) {
      plan.screenshot = { kind: ss, bin: ss };
    } else {
      plan.needs.push('one of: grim (Wayland) / scrot / gnome-screenshot / import (ImageMagick) / spectacle');
    }
    const ip = pickLinuxInput();
    if (ip) {
      plan.input = { kind: ip, bin: ip };
    } else {
      plan.needs.push('xdotool (X11) or ydotool (Wayland)');
    }
  } else if (HOST_OS === 'windows') {
    plan.screenshot = { kind: 'powershell-graphics', bin: 'powershell' };
    plan.input = { kind: 'powershell-sendinput', bin: 'powershell' };
  } else {
    plan.needs.push(`unsupported platform: ${HOST_OS}`);
  }
  plan.ready = plan.needs.length === 0 && plan.screenshot && plan.input;
  return plan;
}
