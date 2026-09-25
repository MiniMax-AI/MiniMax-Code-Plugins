// profile.mjs
//
// Discover, list, and copy browser profiles for Chromium-family
// (Chrome / Chromium / Brave / Edge) and Firefox browsers. The copy is
// used as the --user-data-dir of a private Chrome/Firefox instance so
// the agent inherits cookies, cache, login state, and extensions
// WITHOUT touching the user's original profile.

import { readFile, readdir, mkdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Standard locations for browser profile roots.
function home() { return homedir(); }

const CHROMIUM_ROOTS = {
  darwin: [
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Google/Chrome Beta',
    'Library/Application Support/Google/Chrome Canary',
    'Library/Application Support/Chromium',
    'Library/Application Support/BraveSoftware/Brave-Browser',
    'Library/Application Support/Microsoft Edge',
  ],
  linux: [
    '.config/google-chrome',
    '.config/google-chrome-beta',
    '.config/google-chrome-canary',
    '.config/chromium',
    '.config/BraveSoftware/Brave-Browser',
    '.config/microsoft-edge',
  ],
  win32: [
    'AppData/Local/Google/Chrome/User Data',
    'AppData/Local/Chromium/User Data',
    'AppData/Local/BraveSoftware/Brave-Browser/User Data',
    'AppData/Local/Microsoft/Edge/User Data',
  ],
};

const FIREFOX_ROOTS = {
  darwin: ['Library/Application Support/Firefox/Profiles'],
  linux: ['.mozilla/firefox'],
  win32: ['AppData/Roaming/Mozilla/Firefox/Profiles'],
};

// Find the User Data root directory for Chromium.
async function findRoots(roots) {
  const out = [];
  for (const r of roots) {
    const full = join(home(), r);
    try {
      const st = await stat(full);
      if (st.isDirectory()) out.push({ path: full, browser: r });
    } catch {}
  }
  return out;
}

// List profile directories inside a Chromium User Data root.
// Chromium uses "Default", "Profile 1", "Profile 2", ...
async function listChromiumProfiles(userDataDir) {
  const out = [];
  try {
    const entries = await readdir(userDataDir);
    for (const e of entries) {
      const p = join(userDataDir, e);
      try {
        const st = await stat(p);
        if (!st.isDirectory()) continue;
        // Profile must have a Preferences file.
        const prefs = join(p, 'Preferences');
        const cookies = join(p, 'Cookies');
        if (existsSync(prefs)) {
          out.push({
            name: e,
            path: p,
            hasCookies: existsSync(cookies),
            sizeMB: await dirSizeMB(p),
          });
        }
      } catch {}
    }
  } catch {}
  return out;
}

async function dirSizeMB(p) {
  // Approximate: sum of file sizes (no recursion through symlinks).
  let total = 0;
  const walk = async (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.isFile()) {
        try { total += (await stat(full)).size; } catch {}
      }
    }
  };
  await walk(p);
  return Math.round(total / 1024 / 1024);
}

export async function listAllProfiles() {
  const os = platform();
  const result = { chromium: [], firefox: [] };

  for (const root of await findRoots(CHROMIUM_ROOTS[os] || [])) {
    const profiles = await listChromiumProfiles(root.path);
    if (profiles.length > 0) {
      result.chromium.push({
        userDataDir: root.path,
        browser: basename(root.path),
        profiles,
      });
    }
  }

  for (const root of await findRoots(FIREFOX_ROOTS[os] || [])) {
    const profiles = await listFirefoxProfiles(root.path);
    if (profiles.length > 0) {
      result.firefox.push({
        profilesRoot: root.path,
        profiles,
      });
    }
  }

  return result;
}

// Firefox profile discovery. A Firefox profiles root contains *.default*
// directories and profiles.ini.
async function listFirefoxProfiles(profilesRoot) {
  const out = [];
  try {
    const entries = await readdir(profilesRoot);
    for (const e of entries) {
      if (!/\.(default(-release)?|default)$/.test(e)) continue;
      const p = join(profilesRoot, e);
      try {
        const st = await stat(p);
        if (!st.isDirectory()) continue;
        out.push({
          name: e,
          path: p,
          hasCookies: existsSync(join(p, 'cookies.sqlite')),
          sizeMB: await dirSizeMB(p),
        });
      } catch {}
    }
  } catch {}
  return out;
}

// Copy a Chromium profile to a temp directory. Returns the temp path.
// Use 'copy' mode by default so the user's source profile is untouched.
export async function copyChromiumProfile({ userDataDir, profileName, destRoot }) {
  const src = join(userDataDir, profileName);
  if (!existsSync(src)) throw new Error(`profile not found: ${src}`);
  destRoot = destRoot || mkdtempSync(join(tmpdir(), 'mcode-cu-profile-'));
  const dest = join(destRoot, profileName);
  await mkdir(dest, { recursive: true });
  await copyDirSelective(src, dest);
  return { userDataDir: destRoot, profileName };
}

// Copy a Firefox profile. Requires the source Firefox to NOT be
// running (cookies.sqlite is locked). Returns the temp path.
export async function copyFirefoxProfile({ profilePath, destRoot }) {
  if (!existsSync(profilePath)) throw new Error(`profile not found: ${profilePath}`);
  destRoot = destRoot || mkdtempSync(join(tmpdir(), 'mcode-cu-ff-profile-'));
  const dest = join(destRoot, basename(profilePath));
  await mkdir(dest, { recursive: true });
  await copyDirSelective(profilePath, dest);
  return { profilePath: dest };
}

const SKIP_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'Storage',
  'GrShaderCache', 'ShaderCache', 'component_crx_cache',
  'FileTypePolicies', 'extensions_crx_cache', 'GraphiteDawnCache',
  'Safe Browsing', 'OptimizationGuide', 'OptimizationHints',
  'Recovery', 'System Profile', 'BrowserMetrics-spare.pma',
  'Network', 'Reporting and NEL', 'Site Characteristics Database',
  'DawnWebGPUCache', 'MerchantSignalDataCache',
  // Firefox: skip volatile caches.
  'cache2', 'thumbnails', 'minidumps', 'startupCache', 'OfflineCache',
  'datareporting', 'weave', 'crashes', 'safebrowsing',
]);

async function copyDirSelective(src, dest) {
  await mkdir(dest, { recursive: true });
  let entries;
  try { entries = await readdir(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    const sp = join(src, e.name);
    const dp = join(dest, e.name);
    if (e.isDirectory()) {
      // Skip symlinks to avoid loops.
      let lstat;
      try { lstat = await stat(sp); } catch { continue; }
      if (lstat.isSymbolicLink()) continue;
      await copyDirSelective(sp, dp);
    } else if (e.isFile()) {
      try { await copyFile(sp, dp); } catch {}
    }
  }
}
