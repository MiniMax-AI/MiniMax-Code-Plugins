// Test helper: drive atomicWriteBundle with a controlled failure point.
// Usage: node test/tool-map-helper.mjs <target-dir>
// Honours TOOL_MAP_FAIL_AT_RENAME: if set, the Nth rename in the
// scan.mjs atomicWriteBundle implementation throws (the hook is built
// into scan.mjs). Exits 0 on success, non-zero on expected throw.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = resolve(process.argv[2]);
const scanUrl = pathToFileURL(resolve(process.argv[1], '..', '..', 'plugins', 'antianqi', 'tool-map', 'scripts', 'scan.mjs')).href;

const { atomicWriteBundle } = await import(scanUrl);

atomicWriteBundle(target, {
  'tools.md': 'NEW-MD',
  'tools.json': 'NEW-JSON',
  'tools.summary.md': 'NEW-SUMMARY',
});
console.log('UNEXPECTED success');
process.exit(99);
