import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_RECORDS = 128;
const STALE_TEMP_MS = 5 * 60 * 1_000;
const TEMP_RECORD = /^(?<timestamp>\d{13})-\d{20}-[0-9a-f-]{36}\.tmp$/u;

const event = process.argv[2];
const supportedEvents = new Set(['pre-tool-use', 'post-tool-use']);
if (!supportedEvents.has(event)) throw new Error('expected a configured Hook event name');

let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > 64 * 1024) throw new Error('Hook input exceeds 64 KiB');
}

const dataRoot = process.env.PLUGIN_DATA;
if (!dataRoot || !path.isAbsolute(dataRoot)) throw new Error('PLUGIN_DATA must be an absolute path');

const recordsRoot = path.join(dataRoot, 'events');
await mkdir(recordsRoot, { recursive: true });
const timestamp = Date.now();
const recordStem = `${timestamp.toString().padStart(13, '0')}-${process.hrtime.bigint().toString().padStart(20, '0')}-${randomUUID()}`;
const temporary = path.join(recordsRoot, `${recordStem}.tmp`);
const published = path.join(recordsRoot, `${recordStem}.json`);
await writeFile(
  temporary,
  `${JSON.stringify({ event, timestamp: new Date().toISOString() })}\n`,
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
);
await rename(temporary, published);

const entries = await readdir(recordsRoot, { withFileTypes: true });
const records = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name)
  .sort();
for (const expired of records.slice(0, Math.max(0, records.length - MAX_RECORDS))) {
  try {
    await unlink(path.join(recordsRoot, expired));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const entry of entries.filter((item) => item.isFile())) {
  const match = TEMP_RECORD.exec(entry.name);
  if (!match || timestamp - Number(match.groups.timestamp) <= STALE_TEMP_MS) continue;
  try {
    await unlink(path.join(recordsRoot, entry.name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
