// state.mjs
//
// Small JSON state file with atomic stage-and-rename writes, same
// pattern as examples/hello-mcode-hooks/.../record.mjs.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_STATE_BYTES = 4 * 1024 * 1024; // 4 MB

export async function loadState(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function saveState(path, state) {
  const text = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
    throw new Error(`state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  await mkdir(dirname(path), { recursive: true });
  const staged = path + '.staging';
  await writeFile(staged, text, 'utf8');
  await rename(staged, path);
}

export async function updateState(path, mutator) {
  const cur = await loadState(path);
  const next = await mutator({ ...cur });
  await saveState(path, next);
  return next;
}
