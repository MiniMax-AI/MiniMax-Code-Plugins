// Test helper: drive atomicWriteBundle with FIVE files instead of three
// (the original drive-bundle-failure.mjs uses three, which is fine for
// the Phase-3 mid-bundle test that lands failure on rename #4). The
// brand-new partial-install test needs renames #1-#8 to be triggered
// across Phases 1+3, with failure on #8, so the three-file helper is
// not enough.
//
// Renames driven: #1=md-backup, #2=json-backup, #3=summary-backup
//                 (no backup for new1, new2)
//                 #4=md-install, #5=json-install, #6=summary-install,
//                 #7=new1-install, #8=new2-install
// Triggering TOOL_MAP_FAIL_AT_RENAME=8 causes new2-install to throw
// after new1 has already been renamed onto its (previously-absent) target.
//
// Usage: node test-fixtures/drive-bundle-failure-5.mjs <target-dir>
// Exits 0 on unexpected success, non-zero on expected throw.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = resolve(process.argv[2]);
const scanUrl = pathToFileURL(
  resolve(process.argv[1], '..', '..', 'plugins', 'antianqi', 'tool-map', 'scripts', 'scan.mjs'),
).href;

const { atomicWriteBundle } = await import(scanUrl);

atomicWriteBundle(target, {
  'tools.md': 'NEW-MD',
  'tools.json': 'NEW-JSON',
  'tools.summary.md': 'NEW-SUMMARY',
  'tools.new1': 'NEW-NEW1',
  'tools.new2': 'NEW-NEW2',
});
console.log('UNEXPECTED success');
process.exit(99);
