/**
 * Where a Chrome-based browser lives, on each platform this check can run on.
 *
 * Split out of `browser-check.mjs` so it can be asserted rather than described. The table
 * it replaces was one hardcoded macOS string, so the same check could only ever run on
 * one of the three platforms its own suite runs on — and it reported that as an exit 1,
 * which reads as a failure of the panel rather than of the machine.
 *
 * A candidate list is only useful if it is *this platform's* list, so the platform is a
 * parameter rather than a read of `process.platform` at import time. That is what lets a
 * test on macOS state what a Windows machine would be asked for — which is the only way a
 * cross-platform claim gets checked at all on a machine that is one platform.
 */

import { existsSync } from 'node:fs';

/**
 * Paths to try, in order, for the platform that will run the check.
 *
 * The Windows entries are written with forward slashes and a drive letter on purpose:
 * `existsSync` accepts both separators on Windows, and a table that had to be rewritten
 * for the platform would be a table nobody would keep up to date. Chromium and Edge are
 * listed alongside Chrome because both speak the DevTools protocol this check drives.
 *
 * `CHROME_PATH` replaces the list rather than joining it — an explicit path that is not
 * there should say so, not silently fall through to a different browser than the one the
 * caller named.
 *
 * @param {string} platform `process.platform`
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function chromeCandidates(platform, env = process.env) {
  const override = typeof env.CHROME_PATH === 'string' ? env.CHROME_PATH.trim() : '';
  if (override) return [override];
  return {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ],
  }[platform] ?? [];
}

/**
 * The first candidate that exists, plus every candidate so a failure can say where it
 * looked. Returning the list on success too costs nothing and keeps one code path for
 * both answers.
 */
export function findChrome({ platform = process.platform, env = process.env } = {}) {
  const candidates = chromeCandidates(platform, env);
  return { found: candidates.find((candidate) => existsSync(candidate)) ?? null, candidates };
}