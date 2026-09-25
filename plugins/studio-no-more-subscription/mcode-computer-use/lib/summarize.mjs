// summarize.mjs
//
// Trajectory bookkeeping for the after-N-turns summarization flow.
// State lives at ${PLUGIN_DATA}/state.json; PNGs live at
// ${PLUGIN_DATA}/trajectory/<turn>.png. Summaries live at
// ${PLUGIN_DATA}/trajectory/summaries.jsonl.

import { mkdir, writeFile, rename, readFile, stat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, saveState } from './state.mjs';

const MAX_TRAJECTORY_BYTES = 200 * 1024 * 1024; // 200 MB soft cap

export function summaryEveryFromEnv(env) {
  const raw = env.MCODE_COMPUTER_USE_SUMMARY_EVERY;
  if (!raw) return 10;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

export async function appendFrame({ pluginData, turn, ts, pngBytes, brief }) {
  const dir = join(pluginData, 'trajectory');
  await mkdir(dir, { recursive: true });
  const pngPath = join(dir, `${turn}.png`);
  const staged = pngPath + '.staging';
  await writeFile(staged, pngBytes);
  await rename(staged, pngPath);

  const summaryFile = join(dir, 'summaries.jsonl');
  const line = JSON.stringify({ turn, ts, pngPath, brief: brief || null }) + '\n';
  await writeFile(summaryFile, line, { flag: 'a' });

  await enforceCap(dir);
  return pngPath;
}

async function enforceCap(dir) {
  let total = 0;
  const files = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.png')) continue;
    const p = join(dir, name);
    const st = await stat(p);
    total += st.size;
    files.push({ p, mtime: st.mtimeMs, size: st.size });
  }
  if (total <= MAX_TRAJECTORY_BYTES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  while (total > MAX_TRAJECTORY_BYTES * 0.9 && files.length > 1) {
    const victim = files.shift();
    await unlink(victim.p);
    total -= victim.size;
  }
}

export async function listFrames(pluginData) {
  const dir = join(pluginData, 'trajectory');
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith('.png'))
      .map((n) => Number(n.replace(/\.png$/, '')))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function readFrame(pluginData, turn) {
  const dir = join(pluginData, 'trajectory');
  const p = join(dir, `${turn}.png`);
  try {
    return await readFile(p);
  } catch {
    return null;
  }
}

// Update state.json with the current screenshot count.
export async function bumpScreenshotCount(pluginData) {
  const statePath = join(pluginData, 'state.json');
  const cur = await loadState(statePath);
  const count = (cur.screenshotCount || 0) + 1;
  await saveState(statePath, { ...cur, screenshotCount: count });
  return count;
}

export async function setSummary(pluginData, turn, summaryText) {
  const dir = join(pluginData, 'trajectory');
  await mkdir(dir, { recursive: true });
  const summaryFile = join(dir, 'summaries.jsonl');
  const line = JSON.stringify({ turn, summary: summaryText, ts: new Date().toISOString() }) + '\n';
  await writeFile(summaryFile, line, { flag: 'a' });
}

export async function getSummaries(pluginData) {
  const dir = join(pluginData, 'trajectory');
  const summaryFile = join(dir, 'summaries.jsonl');
  try {
    const text = await readFile(summaryFile, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && j.summary) out.push(j);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
