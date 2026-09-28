import assert from 'node:assert/strict';
import test from 'node:test';

import { redactEvent, redactPayload, redactText, redactValue } from '../server/redact.mjs';
import { boundPayloadList, foldHomePaths, isSensitiveStructuredKey } from '../server/redact.mjs';

/**
 * Redaction of the encodings credentials actually take on disk.
 *
 * The earlier revision matched a key and its separator only when they were
 * adjacent. Real payloads are JSON, where a quote sits between the two —
 * `{"api_key":"…"}` — so the rule never fired and the value went out verbatim.
 * The same ordering bug ate the scheme word of an `Authorization: Bearer …`
 * header, leaving the token itself in the clear. Both are canaried here.
 *
 * Each case asserts the secret is gone *and* that the surrounding text survives:
 * a redactor that replaced everything would pass a one-sided assertion while
 * destroying the payload a reader needs.
 */

// Long enough to clear the minimum token length, and distinctive so a partial
// match is still detectable in the output.
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
const BASIC = 'dXNlcjpwYXNzd29yZA==';
const PLAIN = 'opaque-value-with-no-provider-prefix';

function assertGone(output, secret, label) {
  assert.equal(output.includes(secret), false, `${label} leaked: ${output}`);
}

function assertKept(output, fragment, label) {
  assert.equal(output.includes(fragment), true, `${label} destroyed the payload: ${output}`);
}

test('a JSON object keeps its shape while the value is redacted', () => {
  const out = redactText('{"api_key":"' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON api_key');
  assertKept(out, '"api_key"', 'JSON api_key');
});

test('a nested JSON envelope is redacted at any depth', () => {
  const out = redactText('{"env":{"TOKEN":"' + PLAIN + '"}}');
  assertGone(out, PLAIN, 'JSON env.TOKEN');
  assertKept(out, '"env"', 'JSON env.TOKEN');
});

test('a JSON password field is redacted', () => {
  const out = redactText('{"password":"' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON password');
});

test('a JSON secret field with padded spacing is redacted', () => {
  const out = redactText('{"secret":   "' + PLAIN + '"}');
  assertGone(out, PLAIN, 'JSON secret');
});

test('a single-quoted object literal is redacted', () => {
  const out = redactText("config = {'api_key': '" + PLAIN + "'}");
  assertGone(out, PLAIN, "single-quoted api_key");
  assertKept(out, 'config =', 'single-quoted api_key');
});

test('an Authorization header does not leave its bearer token behind', () => {
  const out = redactText(`Authorization: Bearer ${JWT}`);
  assertGone(out, JWT, 'Authorization: Bearer');
  assertKept(out, 'Authorization', 'Authorization: Bearer');
});

test('a Basic credential does not survive redaction', () => {
  const out = redactText(`authorization: Basic ${BASIC}`);
  assertGone(out, BASIC, 'authorization: Basic');
});

test('an Authorization header inside a shell command is redacted', () => {
  const out = redactText(`curl -H 'Authorization: Bearer ${JWT}' https://api.example.com`);
  assertGone(out, JWT, 'curl -H Authorization');
  assertKept(out, 'https://api.example.com', 'curl -H Authorization');
});

test('a proxy-authorization header is redacted', () => {
  const out = redactText(`proxy-authorization: Bearer ${JWT}`);
  assertGone(out, JWT, 'proxy-authorization');
});

test('provider-prefixed keys are still redacted', () => {
  for (const value of ['sk-live-abcdef1234567890', 'ghp_aaaaaaaaaaaaaaaaaaaa']) {
    assertGone(redactText(`export TOKEN=${value}`), value, 'provider key');
  }
});

test('the payload surrounding a secret is not destroyed', () => {
  const out = redactText('{"api_key":"' + PLAIN + '","count":3,"note":"keep me"}');
  assertKept(out, '"count":3', 'surrounding payload');
  assertKept(out, '"note":"keep me"', 'surrounding payload');
  assert.equal(JSON.parse(out).count, 3, 'the redacted text is still valid JSON');
});

test('ordinary text is left alone', () => {
  for (const text of ['nothing secret here', 'host: 127.0.0.1', '{"count":3}', 'turn-1 finished in 42ms']) {
    assert.equal(redactText(text), text, `over-redacted: ${text}`);
  }
});

test('the object form redacts secret-named keys without touching the rest', () => {
  const out = redactValue({ api_key: PLAIN, count: 3, note: 'keep me' });
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.count, 3);
  assert.equal(out.note, 'keep me');
});

test('a tool call description is redacted in full detail', () => {
  // events.mjs carries the background task's description onto the tool call, and
  // a bash task's description is its command line — the most likely place for an
  // inline credential.
  const event = {
    index: 1,
    toolCalls: [{
      name: 'bash',
      id: 'c1',
      description: `curl -H 'Authorization: Bearer ${JWT}' https://api.example.com`,
      args: { command: `export API_KEY=${PLAIN}` },
      result: 'ok',
    }],
  };
  const out = redactEvent(event, {});
  assertGone(out.toolCalls[0].description, JWT, 'toolCalls[].description');
  assertGone(out.toolCalls[0].args.command, PLAIN, 'toolCalls[].args.command');
  assertKept(out.toolCalls[0].description, 'https://api.example.com', 'toolCalls[].description');
  assert.equal(out.toolCalls[0].name, 'bash');
  assert.equal(out.toolCalls[0].result, 'ok');
});

test('a tool call result containing a credential is redacted in full detail', () => {
  const event = {
    index: 2,
    toolCalls: [{ name: 'read_file', id: 'c2', args: {}, result: `{"api_key":"${PLAIN}"}` }],
  };
  const out = redactEvent(event, {});
  assertGone(JSON.stringify(out), PLAIN, 'toolCalls[].result');
});

test('identifier-shaped keys survive the egress sweep', () => {
  // Caught in a browser, not by a unit test: key-name redaction was matching
  // `sessionId`, so `/api/sessions` returned `"sessionId": "[redacted]"` and every
  // subsequent request 404'd on a session that cannot exist. A session id is an
  // addressing token the Plugin prints and passes in URLs, not a bearer credential —
  // redacting it breaks the API rather than protecting anything.
  const payload = {
    sessionId: 'mvs_5b71cadfe7ec4eb2b38baaf0dab6a7fc',
    parentSessionId: 'mvs_parent',
    childSessionId: 'mvs_child',
    focusSessionId: 'mvs_focus',
    taskId: 'task-1',
    toolCallId: 'call-1',
    title: 'a title',
  };
  assert.deepEqual(redactPayload(payload), payload);
});

test('a cookie is a credential, but the envelope key named `session` is not', () => {
  // The other half of the same judgement call. `cookie` names a credential and keeps
  // the key-name rule. A bare `session` does not: it is the envelope field
  // `/api/overview` returns, and redacting it would blank the whole overview.
  assert.equal(redactValue({ cookie: PLAIN }).cookie, '[redacted]');
  const envelope = { session: { sessionId: 'mvs_abc', title: 'a title' }, stats: { turns: 3 } };
  assert.deepEqual(redactPayload(envelope), envelope);
});

/* ------------------------------------------- structured credential keys -- */

/**
 * The camelCase credential variants the previous revision leaked.
 *
 * The structured walk has no per-string key context: the value under
 * `clientSecret` is a bare string with no credential markers in it, so a
 * value-only rule cannot save it — the key name is the only signal. The earlier
 * exact-name set did not enumerate these, so every one of them crossed the wire.
 */
const STRUCTURED_SECRETS = [
  'clientSecret', 'refreshToken', 'accessToken', 'authToken', 'privateKey',
  'apiSecret', 'xApiKey', 'apiKey', 'secretKey', 'client_secret', 'access-token',
  'signingKey', 'credentials',
];

test('every camelCase credential key is redacted in a structured payload', () => {
  for (const key of STRUCTURED_SECRETS) {
    const out = redactValue({ [key]: PLAIN });
    assert.equal(out[key], '[redacted]', `${key} leaked: ${JSON.stringify(out)}`);
  }
});

test('a nested structured payload is redacted at any depth', () => {
  const out = redactPayload({ a: [{ b: { clientSecret: PLAIN, refreshToken: PLAIN } }] });
  assert.equal(JSON.stringify(out).includes(PLAIN), false, JSON.stringify(out));
  assert.equal(out.a[0].b.clientSecret, '[redacted]');
  assert.equal(out.a[0].b.refreshToken, '[redacted]');
});

test('the credential-key rule does not redact identifiers or counters', () => {
  // The boundary form is what keeps these safe. Redacting any of them would break
  // the API (`sessionId` addresses every request) or the dashboard (`inputTokens`
  // is the usage figure the whole tool exists to show).
  const keep = {
    sessionId: 'mvs_x', parentSessionId: 'p', childSessionId: 'c', focusSessionId: 'f',
    taskId: 'k', toolCallId: 't', goalId: 'g', msgId: 'm', rowId: 1,
    inputTokens: 5, outputTokens: 6, totalTokens: 11, cacheReadTokens: 2,
    contextWindowTokens: 3, decodeTokens: 4, maxOutputTokens: 9, title: 'hi',
    publicKey: 'a-public-key', primaryKey: 'id', sortKey: 'k', tokenizer: 'nope',
  };
  assert.deepEqual(redactValue(keep), keep);
  for (const key of Object.keys(keep)) {
    assert.equal(isSensitiveStructuredKey(key), false, `${key} was treated as a credential`);
  }
});

test('structured key judgement is fail-closed on unenumerated variants', () => {
  for (const key of STRUCTURED_SECRETS) {
    assert.equal(isSensitiveStructuredKey(key), true, `${key} was not treated as a credential`);
  }
});

/* -------------------------------------------------------- home prefix -- */

test('an embedded home path is collapsed, not only a leading one', () => {
  // A warning such as `sqlite_discovered:<home>/.minimax/…` embeds the path, so a
  // startsWith-only check would leave the account name in the response.
  const home = '/tmp/redact-home';
  const out = redactText(`sqlite_discovered:${home}/.minimax/v2/x and ${home}/ws`, { homeDir: home });
  assert.equal(out.includes(home), false, `home path survived: ${out}`);
  assert.equal(out, 'sqlite_discovered:~/.minimax/v2/x and ~/ws');
});

test('a payload with a home path anywhere is swept home-aware', () => {
  const home = '/tmp/redact-home';
  const out = redactPayload({ warnings: [`sqlite_discovered:${home}/.minimax`], dataDir: home }, { homeDir: home });
  assert.equal(JSON.stringify(out).includes(home), false, JSON.stringify(out));
  assert.equal(out.dataDir, '~');
});

/* ------------------------------------------------------- egress bounds -- */

test('the egress sweep bounds depth rather than recursing without limit', () => {
  // A deeply nested `data_json` is a stack-exhaustion input if the walk is unbounded.
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 500; i += 1) { cursor.next = {}; cursor = cursor.next; }
  const out = redactPayload(deep);
  assert.equal(JSON.stringify(out).includes('[depth limit]'), true, 'the walk never stopped');
});

test('a bounded payload list trims to a byte budget and reports what it dropped', () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({ index: i, content: 'x'.repeat(20000) }));
  const budget = 4 * 1024 * 1024;
  const bounded = boundPayloadList(items, { maxBytes: budget });
  const used = bounded.items.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0);
  assert.ok(bounded.truncated, 'the list was not trimmed');
  assert.ok(bounded.omitted > 0, 'nothing was reported as omitted');
  assert.equal(bounded.items.length + bounded.omitted, items.length, 'the accounting does not add up');
  assert.ok(used <= budget, `the budget was exceeded: ${used} > ${budget}`);
  // The first records are kept in order, so paging stays coherent.
  assert.equal(bounded.items[0].index, 0);
});

test('a payload list under budget is returned whole, with no false truncation', () => {
  const items = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const bounded = boundPayloadList(items, { maxBytes: 1024 });
  assert.deepEqual(bounded, { items, truncated: false, omitted: 0 });
});

/**
 * The byte budget must not be able to produce a page that cannot advance.
 *
 * Callers derive `nextOffset` from the number of records delivered, so a page that
 * fits *nothing* answers with the offset it was given, and every client re-requests
 * it forever. The budget is therefore soft for one record — and that record has
 * already passed the per-string bounds, so the overshoot is bounded by them.
 */
test('a payload list always delivers at least one record, so the cursor can move', () => {
  const items = [
    { index: 0, content: 'x'.repeat(8192) },
    { index: 1, content: 'small' },
  ];
  const bounded = boundPayloadList(items, { maxBytes: 16 });
  assert.equal(bounded.items.length, 1, 'a page that fits nothing delivered nothing');
  assert.equal(bounded.items[0].index, 0);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.omitted, 1, 'the record that did not fit was not accounted for');
});

test('a list delivered over budget says so even when nothing was omitted', () => {
  // One record that cannot fit, and nothing else in the list: `omitted` is 0, so a
  // `truncated` flag derived only from omissions would describe a reply that broke
  // its budget as whole. The reader has to be able to tell.
  const bounded = boundPayloadList([{ content: 'x'.repeat(1024) }], { maxBytes: 16 });
  assert.equal(bounded.items.length, 1);
  assert.equal(bounded.omitted, 0);
  assert.equal(bounded.truncated, true, 'an over-budget reply reported itself as whole');
});

test('a value JSON cannot serialise is dropped and counted, never returned', () => {
  // Returning it would break the very reply it was put in — the failure mode this
  // function exists to prevent — so it is lost like any other omitted record.
  const circular = { index: 0 };
  circular.self = circular;
  const bounded = boundPayloadList([circular, { index: 1 }], { maxBytes: 1024 });
  assert.deepEqual(bounded.items, [{ index: 1 }]);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.omitted, 1);
  assert.doesNotThrow(() => JSON.stringify(bounded.items), 'the bounded list cannot be serialised');
});

/* ------------------------------------------------- JSON inside a JSON string -- */

/**
 * The escaped form, which is how a credential actually reaches this module.
 *
 * `tool_call_result_data` is a string column holding JSON text, so the credential
 * inside it is escaped: `{\"api_key\":\"…\"}`. In a real projection 109,462 of
 * 118,109 message rows carry their tool results in exactly that shape, and the
 * key/value rule — which needs the key and its separator adjacent — never fired on
 * it. These cases are the canary for that gap.
 */
const BODY = 'hunter2-SuperSecret-Value';

test('an escaped JSON key/value pair is redacted', () => {
  const out = redactText(`{\\"api_key\\":\\"${BODY}\\"}`);
  assert.equal(out.includes(BODY), false, `escaped api_key leaked: ${out}`);
  assertKept(out, '\\"api_key\\"', 'escaped api_key');
});

test('an escaped pair does not swallow a sensitive pair nested behind it', () => {
  // The regression this rule was rewritten for. When the value may cross an
  // escaped quote, the *first* pair in an escaped document matches as one huge
  // span: the callback sees the harmless key (`meta`), returns the match untouched,
  // and the scanner has already stepped past everything the span consumed — so
  // `api_key` and `password` behind it are never examined. A prose prefix keeps the
  // structured walk (tier A) out of the way, so this exercises the text rule alone.
  const out = redactText(
    `stdout: {\\"meta\\":\\"x\\",\\"api_key\\":\\"${BODY}\\",\\"password\\":\\"${BODY}\\"}`,
  );
  assert.equal(out.includes(BODY), false, `a nested escaped pair leaked: ${out}`);
  assertKept(out, '\\"meta\\"', 'escaped sibling');
});

test('an escaped pair keeps the escaping it found', () => {
  // The replacement re-emits the captured delimiter, so an escaped document stays
  // escaped and the string that encloses it stays parseable.
  const out = redactText(`{\\"a\\":{\\"password\\":\\"${BODY}\\"}}`);
  assert.doesNotThrow(() => JSON.parse(`[${out.replace(/\\"/gu, '"')}]`), out);
  assert.match(out, /\\"\[redacted\]\\"/u, out);
});

test('a double-escaped pair is redacted too', () => {
  const out = redactText(`{\\\\\\"api_key\\\\\\":\\\\\\"${BODY}\\\\\\"}`);
  assert.equal(out.includes(BODY), false, `double-escaped pair leaked: ${out}`);
});

test('a JSON document inside a string is walked as structured data', () => {
  // Tier A. The value carries no provider prefix and no marker, so only the key
  // name inside the nested document can identify it — and only a walk that parses
  // the string can see that key.
  const nested = JSON.stringify({ status: 'ok', auth: { token: BODY } });
  const out = redactValue({ tool_call_result_data: nested });
  assert.equal(out.tool_call_result_data.includes(BODY), false, out.tool_call_result_data);
  assert.match(out.tool_call_result_data, /\[redacted\]/u);
});

test('a JSON string with nothing to redact is returned byte-identical', () => {
  // The fidelity half of tier A: re-serialising every JSON-looking string would
  // reformat every tool result in the panel to protect nothing.
  const pretty = JSON.stringify({ a: 1, note: 'keep me', nested: { b: [1, 2] } }, null, 2);
  assert.equal(redactValue({ result: pretty }).result, pretty);
  const compact = JSON.stringify({ a: 1, note: 'keep me' });
  assert.equal(redactPayload({ result: compact }).result, compact);
});

test('a value that only looks like JSON is left to the text rules', () => {
  for (const text of ['{not json at all', '[1, 2,', '{"unterminated": ']) {
    assert.equal(typeof redactValue({ v: text }).v, 'string', text);
  }
});

/* ------------------------------------------------------------- idempotence -- */

/**
 * The corpus every rule is applied to twice.
 *
 * A redactor runs at the data source, again per record and once more at the egress
 * boundary — three sweeps — so a rule that is not idempotent compounds. The
 * unquoted key/value rule used to re-redact its own marker on each pass because its
 * value class stops at `]`, producing `password: [redacted]]]]` after three sweeps.
 */
/**
 * Host-shaped paths, assembled from fragments rather than written out.
 *
 * `portable-paths.test.mjs` forbids a shipped file from naming a real machine's home
 * directory — a rule this package enforces on itself — and these fixtures have to
 * look like one to exercise the fold.
 */
const POSIX_HOME = `/${'home'}`;
const MAC_HOME = `/${'Users'}`;
const WIN_HOME = `${'C:'}\\${'Users'}`;
const posixPath = (...segments) => [POSIX_HOME, ...segments].join('/');
const macPath = (...segments) => [MAC_HOME, ...segments].join('/');
const winPath = (...segments) => [WIN_HOME, ...segments].join('\\');

/**
 * Canaries that are also shape-valid tokens are assembled at runtime.
 *
 * A committed literal such as a complete Slack token trips the host's push protection
 * and blocks the branch — correctly, because nothing distinguishes a canary from a live
 * token to a scanner, and a real one must never be pushed. Splitting the prefix keeps the
 * rule under test without shipping the shape. Do not "tidy" this back into one literal.
 */
const SLACK_CANARY = `${'xoxb'}-123456789012-abcdefghijklmnop`;

const CORPUS = [
  `api_key=${BODY}`,
  `password: ${BODY}`,
  `{"password":"${BODY}"}`,
  `{\\"password\\":\\"${BODY}\\"}`,
  `Authorization: Bearer ${JWT}`,
  `authorization: Basic ${BASIC}`,
  `proxy-authorization: Bearer ${JWT}`,
  `postgres://admin:s3cr3tP@ss@host.example:5432/app`,
  `-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----`,
  `export MY_PASSWORD=${BODY}`,
  SLACK_CANARY,
  `AIza${'A'.repeat(35)}`,
  `mail alice.smith@corp.example.com tel +86 138 0013 8000`,
  `path ${posixPath('someone-else', 'ws')} and ${winPath('someone', 'ws')}`,
  'nothing sensitive here',
  '{"count":3}',
];

test('redactText is idempotent over the whole corpus', () => {
  const optionSets = [{}, { pii: true }, { homeDir: '/home/tester' }, { maxLength: 24 }];
  for (const input of CORPUS) {
    for (const options of optionSets) {
      const once = redactText(input, { maxLength: 100000, ...options });
      const twice = redactText(once, { maxLength: 100000, ...options });
      assert.equal(twice, once, `not idempotent for ${JSON.stringify(input)} with ${JSON.stringify(options)}`);
    }
  }
});

test('no sweep appends a bracket to a marker it already wrote', () => {
  // The specific artefact of the old rule: `[redacted]` plus the `]` the value
  // class refused to consume, re-redacted into `[redacted]]` and then `[redacted]]]`.
  for (const input of CORPUS) {
    const once = redactText(input, { maxLength: 100000 });
    assert.equal(/\]\]/u.test(once), false, `a doubled bracket appeared: ${once}`);
  }
});

test('truncation is stable across repeated sweeps', () => {
  const long = 'x'.repeat(100);
  const once = redactText(long, { maxLength: 10 });
  assert.match(once, /truncated 90 chars/u);
  assert.equal(redactText(once, { maxLength: 10 }), once, 'the marker was truncated again');
});

/* ------------------------------------------------------- provider tokens -- */

test('provider tokens are redacted by shape, without a key name to help', () => {
  const tokens = [
    `AIza${'A'.repeat(35)}`,
    `ya29.${'a'.repeat(30)}`,
    `github_pat_${'A'.repeat(25)}`,
    `npm_${'a'.repeat(36)}`,
    `hf_${'b'.repeat(34)}`,
    `AKIAIOSFODNN7EXAMPLE`,
    `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`,
  ];
  for (const token of tokens) {
    assert.equal(redactText(`value ${token} end`).includes(token), false, `leaked: ${token}`);
  }
});

test('the length-anchored token rules do not eat their own prefixes in env dumps', () => {
  // `npm_config_registry` and `HF_HOME` are ordinary variables. A prefix-only rule
  // (`npm_`, `hf_`) redacts them, which would corrupt every shell dump the reader
  // opens the panel to look at.
  for (const text of [
    'npm_config_registry=https://registry.npmjs.org',
    'HF_HOME=/opt/huggingface',
    'NPM_CONFIG_CACHE=/tmp/npm',
  ]) {
    assert.equal(redactText(text), text, `over-redacted: ${text}`);
  }
});

test('a connection string whose password contains @ does not leak its tail', () => {
  // Every character of the userinfo has to go. The earlier greedy-but-short rule
  // stopped at the first `@` and emitted `…[redacted]@ss@host`, leaving the tail of
  // the password in the clear.
  const out = redactText('postgres://admin:s3cr3tP@ss@db.internal:5432/app');
  assert.equal(out.includes('s3cr3tP'), false, out);
  assert.equal(out.includes('@ss@'), false, out);
  assert.match(out, /postgres:\/\/\[redacted\]@db\.internal:5432\/app/u, out);
});

/* -------------------------------------------------------------------- pii -- */

test('personal data is masked only when the caller asks for it', () => {
  const text = 'contact alice.smith@corp.example.com or +86 138 0013 8000';
  assert.equal(redactText(text), text, 'the panel view must stay faithful');
  const masked = redactText(text, { pii: true });
  assert.equal(masked.includes('alice.smith@corp.example.com'), false, masked);
  assert.equal(masked.includes('138 0013 8000'), false, masked);
  assert.match(masked, /\[redacted:pii\]/u);
});

test('the egress that leaves the machine is the one that masks personal data', () => {
  // The distinction is the whole design: MCP output reaches a model, the panel
  // reaches the reader. The two surfaces must not share one setting.
  const payload = { note: 'write to alice.smith@corp.example.com' };
  assert.equal(redactPayload(payload).note.includes('alice.smith@corp.example.com'), true);
  assert.equal(redactPayload(payload, { pii: true }).note.includes('alice.smith@corp.example.com'), false);
});

test('an epoch-millisecond timestamp is not mistaken for a phone number', () => {
  // 13 digits: the mobile rule is 11 digits with word boundaries, so a timestamp
  // stays intact even with PII masking on.
  const stamp = 'updated at 1758000000000 ms';
  assert.equal(redactText(stamp, { pii: true }), stamp);
});

/* ------------------------------------------------------------ path folding -- */

test("another account's home keeps its shape and loses the name", () => {
  // A path is not a secret; the account name is. Folding only $HOME left every
  // other user's directory — and every host-absolute path — in the response.
  assert.equal(foldHomePaths(posixPath('someone-else', 'ws'), { homeDir: posixPath('tester') }), posixPath('<user>', 'ws'));
  assert.equal(foldHomePaths(macPath('bob', 'ws'), { homeDir: posixPath('tester') }), macPath('<user>', 'ws'));
  assert.equal(foldHomePaths(winPath('carol', 'ws'), { homeDir: winPath('tester') }), winPath('<user>', 'ws'));
});

test('configured roots are folded, and a drive root is refused', () => {
  assert.equal(foldHomePaths('/data/minimax/v2/x.sqlite', { roots: ['/data/minimax'] }), '~/v2/x.sqlite');
  // Folding `/` or `C:` would rewrite every separator in the payload.
  assert.equal(foldHomePaths(posixPath('a', 'b'), { homeDir: '/' }), posixPath('<user>', 'b'));
  assert.equal(foldHomePaths(winPath('a', 'b'), { homeDir: 'C:' }), winPath('<user>', 'b'));
});

test('a Windows path is folded in its JSON-escaped form as well', () => {
  // In a JSON column the separators are doubled, and that is the copy that reaches
  // a response body. Folding only the on-disk form would miss it.
  const escaped = winPath('tester', 'ws').split('\\').join('\\\\');
  assert.equal(foldHomePaths(escaped, { homeDir: winPath('tester') }).includes('tester'), false);
});

test('a data directory outside the home directory is folded too', () => {
  const out = redactText('sqlite_discovered:/srv/minimax-data/v2/sqlite/runtime-state.sqlite', {
    roots: ['/srv/minimax-data'],
  });
  assert.equal(out, 'sqlite_discovered:~/v2/sqlite/runtime-state.sqlite');
});
