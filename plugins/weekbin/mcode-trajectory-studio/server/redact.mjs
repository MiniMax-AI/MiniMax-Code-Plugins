/**
 * Redaction and bounding for content that may leave the local process.
 *
 * The Studio serves to 127.0.0.1 only, but tool arguments and results routinely
 * carry credentials, and the MCP surface hands payloads to a model whose context
 * leaves the machine. Every `full` payload is therefore scrubbed and bounded
 * before it is returned over MCP or written into the HTML page.
 *
 * Four properties matter more than cleverness here:
 *
 *   **Order.** Rules run most-specific first. An `Authorization: Bearer …` header
 *   has to be consumed as a whole, because a generic key/value rule would eat the
 *   header name and leave the token with nothing to anchor the scheme match —
 *   which is exactly how an earlier revision emitted `Authorization=[redacted]
 *   <token>` with the token intact.
 *
 *   **Shape.** A redaction preserves the surrounding syntax, so the result stays
 *   valid JSON and the payload a reader needs survives. Replacing everything with
 *   `[redacted]` would be safer and useless.
 *
 *   **Tier A before tier B.** The runtime stores tool results as JSON *text*, not
 *   as objects, so the credential in a tool result arrives as
 *   `{\"api_key\":\"…\"}` — a JSON document inside a JSON string. Two independent
 *   passes cover that: a structured walk of any string value that parses as JSON
 *   (tier A), and an escape-aware key/value rule that tolerates backslash-escaped
 *   delimiters (tier B). Neither alone is enough — tier A needs a well-formed
 *   document, tier B needs only the shape — and an earlier revision had neither,
 *   so a credential in a tool result crossed the wire unredacted.
 *
 *   **Idempotence.** Applying the set twice equals applying it once. Text is
 *   redacted at the data source and swept again at the egress boundary, and a
 *   second pass must not corrupt the first one's output. Every rule, the
 *   truncation marker and the path folding are written to satisfy this, and
 *   `test/redact.test.mjs` asserts it over the whole corpus rather than by
 *   inspection.
 *
 * What this cannot do is stated in README under "隐私": it recognises credential
 * *shapes* and credential-named *keys*, so an unlabelled high-entropy string is not
 * a credential to it, and a workspace path outside the folded roots is returned
 * verbatim. Those are documented limits, not oversights.
 */

/* ------------------------------------------------------------------ markers -- */

/** A plain `[redacted]` marker already in place. */
const REDACTED = '[redacted]';

/** Personal data, masked only on the surface that leaves the machine. */
const REDACTED_PII = '[redacted:pii]';

/** Another account's home directory keeps its shape but loses the account name. */
const USER_PLACEHOLDER = '<user>';

/**
 * The truncation marker, matched as a whole so a second pass does not truncate the
 * text again and grow the omitted count on every sweep.
 */
const TRUNCATION = /\n… \[truncated (\d+) chars\]$/u;

/* --------------------------------------------------------- key judgement -- */

/**
 * The credential vocabulary, shared by the free-text rule and the structured walk.
 *
 * Delimited so camelCase and snake_case agree, and deliberately *not* including a
 * plural `tokens`: the anchored shape is what keeps counters (`inputTokens`,
 * `total_tokens`) and identifiers (`sessionId`) out, and a `tokens?` alternative
 * would start eating `total_tokens`.
 */
const CREDENTIAL_WORDS = [
  'api[_-]?key', 'apikey', 'api[_-]?secret', 'secret', 'secrets', 'secret[_-]?key',
  'token', 'passwd', 'password', 'passphrase', 'pwd', 'credential', 'credentials',
  'authorization', 'auth[_-]?token', 'access[_-]?token', 'access[_-]?key',
  'refresh[_-]?token', 'private[_-]?key', 'signing[_-]?key', 'session[_-]?key',
  'encryption[_-]?key', 'client[_-]?secret', 'consumer[_-]?secret',
  'webhook[_-]?secret', 'cookie',
];

/**
 * A key whose value is a credential, in free text.
 *
 * Adds `session[_-]?id` to the shared vocabulary because a *text* occurrence of a
 * session id is never an addressing token — nothing in this Plugin parses one out
 * of a message body — while the structured walk must keep it (see below).
 */
const SENSITIVE_KEY = new RegExp(
  `(?:^|[_.-])(?:${CREDENTIAL_WORDS.join('|')}|session[_-]?id)(?:$|[_.-])`,
  'i',
);

/**
 * Split a camelCase or PascalCase key so the delimited patterns above can see its
 * words: `secretKey` → `secret_Key`, `AWSSecretKey` → `AWS_Secret_Key`.
 */
function normalizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2');
}

/**
 * Whether a key name carries a credential.
 *
 * Deliberately fail-closed: a name that merely contains a sensitive word with no
 * word boundary (`tokenizer`, `secretary`) is treated as sensitive too, while the
 * anchored shape keeps counter-like names (`inputTokens`, `total_tokens`) out.
 */
export function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY.test(normalizeKey(key));
}

/**
 * Structured keys whose value is a credential.
 *
 * Same vocabulary as `SENSITIVE_KEY` with one deliberate difference:
 * `session[_-]?id` is absent. It reads like a credential and is one in many APIs,
 * but in this runtime's schema a session id is an *addressing token*: the Plugin
 * prints it, passes it in every URL, and matches rows on it. Treating it as a
 * secret broke the whole API — `/api/sessions` returned `"sessionId":
 * "[redacted]"` and every following request 404'd.
 *
 * The earlier revision used an *exact-name* set instead, and that leaked every
 * camelCase variant it had not enumerated — `clientSecret`, `refreshToken`,
 * `accessToken`, `authToken`, `apiSecret`, `xApiKey` — precisely because the
 * structured walk has no per-string key context to fall back on: the value is a
 * bare string with no credential markers in it, so value-only redaction cannot
 * help. The containment form below covers them all by construction.
 */
const STRUCTURED_SECRET_KEY = new RegExp(
  `(?:^|[_.-])(?:${CREDENTIAL_WORDS.join('|')})(?:$|[_.-])`,
  'iu',
);

/** Whether a *structured* object key names a credential. See the pattern above. */
export function isSensitiveStructuredKey(key) {
  return typeof key === 'string' && STRUCTURED_SECRET_KEY.test(normalizeKey(key));
}

/* ---------------------------------------------------------------- helpers -- */

/** `"v"` → `"[redacted]"`, keeping whichever quote the payload used. */
function redactQuoted(value) {
  const delim = value[0];
  const quoted = delim === '"' || delim === "'";
  return quoted ? `${delim}${REDACTED}${delim}` : REDACTED;
}

/**
 * A value already redacted, so a second pass leaves it alone.
 *
 * Three shapes count. A complete marker, for the quoted case. `[redacted` without
 * its closing bracket, because the unquoted value class deliberately stops at `]`
 * so a JSON array's bracket is not swallowed — without this the rule re-redacts its
 * own output and adds one `]` per sweep. And any *prefix* of a marker, which is
 * what a previous truncation leaves behind: at a small `maxLength` the bound cuts
 * `[redacted]` to `[re`, and re-redacting that fragment grows the text and shifts
 * the omitted count on every subsequent sweep. None of those prefixes can carry a
 * secret — they are at most nine characters of the marker's own spelling.
 */
function alreadyRedacted(value) {
  const delim = value[0];
  const quoted = delim === '"' || delim === "'";
  const inner = quoted ? value.slice(1, -1) : value;
  if (inner.length === 0) return false;
  return REDACTED.startsWith(inner) || REDACTED_PII.startsWith(inner);
}

/* ------------------------------------------------------------------ rules -- */

const RULES = [
  {
    // A private key block is one credential, not a key/value pair.
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    to: () => '[redacted private key]',
  },
  {
    // Inline credentials in a connection string. The userinfo run is greedy within
    // the authority section, so a password that itself contains `@` is consumed
    // whole: `postgres://admin:s3cr3tP@ss@host` used to stop at the first `@` and
    // emit `postgres://[redacted]:[redacted]@ss@host`, leaving the tail of the
    // password in the clear.
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi,
    to: (_match, scheme) => `${scheme}${REDACTED}@`,
  },
  {
    // The Authorization header as a whole, scheme included. This has to precede
    // the key/value rule below; see the module comment.
    re: /\b((?:proxy-)?authorization)(\s*[:=]\s*)(?:bearer|basic|token|digest)?\s*[A-Za-z0-9._~+/=+-]{8,}/gi,
    to: (_match, name, separator) => `${name}${separator}${REDACTED}`,
  },
  {
    // A scheme and token with no header name in front of it.
    re: /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=+-]{8,}/gi,
    to: (_match, scheme, space) => `${scheme}${space}${REDACTED}`,
  },
  {
    // Provider-shaped keys, even when nothing labels them.
    re: /\b(sk|pk|rk|ghp|gho|ghs|ghr|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
    to: () => REDACTED,
  },
  {
    // Fixed-width provider tokens. Length-anchored rather than prefix-anchored, so
    // `npm_config_registry` and `hf_home` — both ordinary environment variables in
    // a shell dump — are not mistaken for the tokens they share a prefix with.
    re: /\b(?:github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/g,
    to: () => REDACTED,
  },
  {
    // AWS access key ids.
    re: /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g,
    to: () => REDACTED,
  },
  {
    // Azure storage keys, which carry their own label and so need no key match.
    re: /\bAccountKey=[A-Za-z0-9+/=]{40,}/g,
    to: () => 'AccountKey=[redacted]',
  },
  {
    // A JWT with no key and no scheme in front of it. Three base64url segments;
    // the `eyJ` head is the fixed `{"` prefix of a JOSE header, which is what makes
    // this specific enough to fire on its own.
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    to: () => REDACTED,
  },
  {
    /*
     * Escaped-JSON key/value: `\"api_key\":\"value\"`.
     *
     * This is the form a JSON document takes when it is stored inside a JSON
     * *string*, which is how the runtime persists tool results. Each delimiter is
     * captured with its own backslash run and re-emitted verbatim, so the escaped
     * payload stays escaped and the enclosing document stays parseable. Both sides
     * must carry the identical delimiter, which is what keeps a `"` from pairing
     * with a `\"`.
     *
     * Must precede the plain key/value rule: that one requires the key and its
     * separator to be adjacent, which the escaped form never is.
     *
     * The value may carry backslashes but may not contain an escaped quote. That
     * exclusion is what keeps the rule from spanning: with a value that could cross
     * `\"`, the *outer* pair of an escaped document matches first
     * (`\"tool_call_result_data\":\"{…\"`), the callback sees a harmless key, and
     * the whole span — including the sensitive pair nested inside it — is consumed
     * before the scanner ever reaches it. A value that genuinely contains escaped
     * quotes is a nested document, which tier A handles.
     */
    re: /(\\*["'])([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)(\\*["'])((?:[^"\\]|\\(?!["]))*?)\4/g,
    to: (match, keyDelim, key, separator, valueDelim, value) => {
      if (!isSensitiveKey(key)) return match;
      if (alreadyRedacted(value)) return match;
      return `${keyDelim}${key}${keyDelim}${separator}${valueDelim}${REDACTED}${valueDelim}`;
    },
  },
  {
    // `key: value`, where a quote may sit between the key and the separator — the
    // JSON object form, which an adjacency-requiring pattern silently skips. The
    // key class is a single bounded quantifier so the scan stays linear; whether a
    // key is sensitive is decided in the callback.
    re: /(["']?)([A-Za-z0-9_.-]{1,64})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;'"`)}]+)/g,
    to: (match, quote, key, separator, value) => {
      if (!isSensitiveKey(key)) return match;
      if (alreadyRedacted(value)) return match;
      return `${quote}${key}${quote}${separator}${redactQuoted(value)}`;
    },
  },
  {
    /*
     * Personal data. Off by default and enabled only on the surface that leaves the
     * machine — the MCP egress — because the panel is the reader's own screen and
     * masking a customer's e-mail address in it would destroy the answer they
     * opened the panel for.
     */
    pii: true,
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    to: () => REDACTED_PII,
  },
  {
    pii: true,
    re: /\+\d[\d\s().-]{6,16}\d/g,
    to: () => REDACTED_PII,
  },
  {
    // A mainland-China mobile number. Eleven digits starting `1[3-9]`; an epoch
    // millisecond value has thirteen digits, so the word boundaries exclude it.
    pii: true,
    re: /\b1[3-9]\d{9}\b/g,
    to: () => REDACTED_PII,
  },
];

/* -------------------------------------------------------------- path folding -- */

/**
 * The literal forms a root can take on disk and inside a JSON string.
 *
 * A Windows path serialised into a JSON column appears with its backslashes
 * doubled, so folding only the on-disk form would leave the escaped copy — the one
 * that actually reaches a response body — untouched.
 */
function rootVariants(root) {
  const trimmed = root.replace(/[/\\]+$/u, '');
  // A single separator or a bare drive letter is not a directory: folding it would
  // replace every path separator in the payload.
  if (trimmed.length < 2 || /^[A-Za-z]:$/u.test(trimmed)) return [];
  const variants = new Set([trimmed]);
  if (trimmed.includes('\\')) variants.add(trimmed.split('\\').join('\\\\'));
  return [...variants];
}

/**
 * Collapse the configured roots to `~` and every other account's home to `<user>`.
 *
 * Replacing the root anywhere it appears — not only at the start of the string —
 * is what keeps a path from leaking inside a warning (`sqlite_discovered:~/.minimax/…`),
 * a workspace field or a tool argument. The account-mask pass then covers the paths
 * the root list cannot know about: another user's home on a shared machine still
 * names a person, so the name goes and the shape stays.
 */
export function foldHomePaths(value, { homeDir, roots = [] } = {}) {
  if (typeof value !== 'string' || !value) return value;
  let out = value;
  for (const root of [homeDir, ...roots]) {
    if (typeof root !== 'string' || root.length < 2) continue;
    for (const variant of rootVariants(root)) out = out.split(variant).join('~');
  }
  return out.replace(
    /([/\\](?:home|Users)[/\\])([^/\\\s"',:;)\]}]+)/gu,
    (_match, prefix) => `${prefix}${USER_PLACEHOLDER}`,
  );
}

/* ------------------------------------------------------------------ redact -- */

/**
 * Scrub every credential encoding a string may carry, collapse the configured
 * roots, then bound its length.
 *
 * `homeDir` and `roots` are optional; `pii` is off unless a caller that leaves the
 * machine asks for it.
 */
export function redactText(value, { maxLength = 4000, homeDir, roots, pii = false } = {}) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const rule of RULES) {
    if (rule.pii && !pii) continue;
    text = text.replace(rule.re, rule.to);
  }
  text = foldHomePaths(text, { homeDir, roots });
  return boundLength(text, maxLength);
}

/**
 * Truncate to `maxLength`, counting any earlier truncation rather than truncating
 * the earlier marker.
 *
 * The naive form is not idempotent: the marker itself makes the string longer than
 * the limit, so a second sweep cuts into the marker and appends a new one, and the
 * bound grows by a marker per pass.
 */
function boundLength(text, maxLength) {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  const prior = TRUNCATION.exec(text);
  const body = prior ? text.slice(0, prior.index) : text;
  const already = prior ? Number(prior[1]) : 0;
  if (body.length <= maxLength) return text;
  const omitted = body.length - maxLength + already;
  return `${body.slice(0, maxLength)}\n… [truncated ${omitted} chars]`;
}

/* ------------------------------------------------------ JSON inside a string -- */

/** Ceiling for a string that will be re-parsed as JSON; beyond it, text rules only. */
const JSON_IN_STRING_BYTES = 512 * 1024;

/** How many levels of JSON-in-a-string nesting tier A will follow. */
const JSON_IN_STRING_DEPTH = 4;

/**
 * Tier A: redact a string that is itself a JSON document, and only rewrite it when
 * a redaction actually fired.
 *
 * The equality test is the point. Re-serialising every JSON-looking string would
 * reformat every tool result in the panel — collapsing indentation, changing escape
 * styles — to protect nothing in the overwhelmingly common case where the document
 * holds no credential. So the original bytes are returned unless the walk changed
 * something.
 *
 * @returns {string|null} the redacted document, or null when the value is not JSON
 *   or nothing changed.
 */
function redactJsonText(text, options, depth) {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  if (trimmed.length < 2 || Buffer.byteLength(trimmed, 'utf8') > JSON_IN_STRING_BYTES) return null;
  const last = trimmed[trimmed.length - 1];
  if (last !== '}' && last !== ']') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const swept = walk(parsed, options, depth + 1);
  if (JSON.stringify(swept) === JSON.stringify(parsed)) return null;
  // Keep a pretty-printed document readable when it had been pretty-printed.
  const indent = /\n\s+["}\]\[]/u.test(trimmed) ? 2 : 0;
  return JSON.stringify(swept, null, indent);
}

/* ------------------------------------------------------------------- walk -- */

/**
 * Deep-walk a value, redacting every string it contains.
 *
 * Structural bounds are optional and default to none: the per-read sweep passes
 * none because the payload was already bounded by the caller's own limits, and
 * truncating an event list here would silently drop records. `redactPayload` is the
 * bounded egress variant, for callers that want breadth and depth caps.
 */
function walk(value, options, depth) {
  const { maxLength, maxDepth, maxEntries, homeDir, roots, pii } = options;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const nested = depth < JSON_IN_STRING_DEPTH ? redactJsonText(value, options, depth) : null;
    return redactText(nested ?? value, { maxLength, homeDir, roots, pii });
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (maxDepth !== undefined && depth >= maxDepth) return '[depth limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, maxEntries).map((item) => walk(item, options, depth + 1));
    if (value.length > maxEntries) head.push(`… [${value.length - maxEntries} more items]`);
    return head;
  }
  if (typeof value === 'object') {
    const out = {};
    let seen = 0;
    for (const [key, item] of Object.entries(value)) {
      if (seen >= maxEntries) {
        out['…'] = `${Object.keys(value).length - maxEntries} more keys`;
        break;
      }
      seen += 1;
      // A structured key is judged by containment, not by an exact name, so
      // `clientSecret`/`refreshToken` cannot slip through as `secret`/`token` variants.
      out[key] = isSensitiveStructuredKey(key) ? REDACTED : walk(item, options, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Recursively scrub a JSON-ish value, bounding depth, breadth and string length. */
export function redactValue(value, options = {}, depth = 0) {
  const { maxLength = 4000, maxDepth = 12, maxEntries = 200 } = options;
  return walk(value, {
    maxLength, maxDepth, maxEntries, homeDir: options.homeDir, roots: options.roots, pii: options.pii,
  }, depth);
}

/**
 * Redact an outbound payload of any shape, without restructuring it.
 *
 * Unlike the per-read sweep this one *is* bounded: a response the caller built from
 * many records still has to fit through one socket, so depth, breadth and string
 * length all have finite defaults. A payload whose own limits are larger than these
 * passes its own `options` explicitly.
 *
 * `pii` is off by default and set by the MCP boundary, which is the one egress that
 * leaves the machine.
 */
export function redactPayload(value, {
  maxLength = 4000, maxDepth = 64, maxEntries = 10000, homeDir, roots, pii = false,
} = {}) {
  return walk(value, { maxLength, maxDepth, maxEntries, homeDir, roots, pii }, 0);
}

/** Redact an MCP event payload in `full` mode. */
export function redactEvent(event, options = {}) {
  return redactPayload(event, options);
}

/** Home-directory prefixes are stripped so paths do not leave the machine verbatim. */
export function redactPath(value, { homeDir, roots } = {}) {
  return foldHomePaths(value, { homeDir, roots });
}

/**
 * Cap the serialized size of a record list in one response.
 *
 * A per-string limit is not a per-response limit: a thousand `full` records each
 * bounded to 20 KB serialise to ~20 MB, and the caller can ask for exactly that.
 * This walks the list in order, accumulating the serialized size, and stops once
 * the next record would cross `maxBytes` — reporting how many were dropped so the
 * client can page on `nextOffset` instead of assuming it saw everything.
 *
 * The budget is soft for exactly one record. Callers derive their next cursor from
 * the number of records delivered, so a page that fits *nothing* would answer
 * `nextOffset: <the same offset>` and every client would re-request it forever.
 * One record over budget beats a stream that cannot advance, and every record has
 * already passed the per-string bounds, so the overshoot is bounded by those.
 *
 * `truncated` is true when records were dropped *or* when that one record had to go
 * over. Reporting only the omission would let a reply that exceeded its budget —
 * possibly by an order of magnitude — describe itself as whole.
 *
 * A value JSON cannot serialise is dropped rather than returned — it would break
 * the reply it was put in — and it is counted in `omitted` like any other loss.
 */
export function boundPayloadList(items, { maxBytes } = {}) {
  if (!Array.isArray(items)) return { items: [], truncated: false, omitted: 0 };
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { items: items.slice(), truncated: false, omitted: 0 };
  }
  const kept = [];
  let used = 0;
  let overBudget = false;
  for (const item of items) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8');
    } catch {
      continue;
    }
    if (used + size > maxBytes) {
      if (kept.length > 0) break;
      overBudget = true;
    }
    kept.push(item);
    used += size;
  }
  const omitted = items.length - kept.length;
  return { items: kept, truncated: omitted > 0 || overBudget, omitted };
}
