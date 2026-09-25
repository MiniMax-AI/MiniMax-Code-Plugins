#!/usr/bin/env node
// PreCompact hook for mcode-computer-use.
// Emits a decision-bearing response so the runtime surfaces a confirmation
// pill before context compaction fires (per proposals/hooks-detailed-spec.md
// § Decision semantics, "ask" value).

import { argv } from 'node:process';
import { loadState } from '../../../lib/state.mjs';

const args = parseArgs(argv.slice(2));
const statePath = args.state;

let count = 0;
if (statePath) {
  const cur = await loadState(statePath);
  count = cur.screenshotCount || 0;
}

const body = {
  hookSpecificOutput: {
    hookEventName: 'PreCompact',
    decision: 'ask',
    reason: `computer-use session has ${count} screenshot turns; ` +
            'consider summarization via record_summary before compacting.',
  },
};
process.stdout.write(JSON.stringify(body));
process.exit(0);

function parseArgs(args) {
  const out = { state: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') { out.state = args[i + 1]; i += 1; }
  }
  return out;
}
