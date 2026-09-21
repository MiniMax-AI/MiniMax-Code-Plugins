// webui/scripts/check-docs-alignment.mjs
// CI gate for mcode-webui v2 — lease B05.
//
// Asserts the three "single-source-of-truth" relationships between
// the manifest (`plugin.json`), the documentation set
// (`README.md` + `docs/API.md` + `docs/CAPABILITIES.md`), the
// security disclosure (`references/SECURITY-NOTES.md`), and the
// server code (`server/router.js`, `server/lib/config.js`).
//
// Each check prints a one-line PASS or a list of mismatches with the
// file path + missing identifier. Exits 0 when everything is aligned,
// 1 when at least one mismatch was found, 2 when the script itself
// fails to load its inputs (missing file, malformed JSON, etc.).
//
// Usage:
//   node scripts/check-docs-alignment.mjs
//   npm run check
//
// No external deps — Node 22+ stdlib only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// -----------------------------------------------------------------------
// Tiny helpers
// -----------------------------------------------------------------------

const TAG = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function read(rel) {
  try {
    return readFileSync(resolve(ROOT, rel), "utf8");
  } catch (e) {
    console.error(`${TAG.red("ERROR")} cannot read ${rel}: ${e.message}`);
    process.exit(2);
  }
}

function parseJson(rel) {
  const raw = read(rel);
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`${TAG.red("ERROR")} ${rel} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

// Does `path` resolve somewhere in `routerSrc`?
//
// router.js uses two patterns:
//   1. literal matchers: `match: (p) => p === "/api/foo"`
//   2. dynamic prefix matchers: `match: (p) => p.startsWith("/api/sessions/") && p.length > ...`
//
// `:id`-style placeholders in the docs (e.g. `/api/sessions/:id`) need
// to be normalized to their prefix before lookup so that they match
// the dynamic case.
function pathMatches(path, routerSrc) {
  // Literal substring match.
  if (routerSrc.includes(path)) return true;
  // `:id`-style placeholders — strip the parameter and look for a
  // startsWith(prefix + "/") guard. This is what router.js does for
  // `DELETE /api/sessions/:id`.
  const colonMatch = path.match(/^(.*)\/:[A-Za-z_][A-Za-z0-9_]*$/);
  if (colonMatch) {
    const prefix = colonMatch[1];
    if (routerSrc.includes(`p.startsWith("${prefix}/"`)) return true;
    if (routerSrc.includes(`p.startsWith('${prefix}/'`)) return true;
  }
  return false;
}

const mismatches = [];
function check(label, ok, details) {
  if (ok) {
    console.log(`  ${TAG.green("✓")} ${label}`);
    return true;
  }
  console.log(`  ${TAG.red("✗")} ${label}`);
  for (const d of details || []) console.log(`      ${TAG.red("-")} ${d}`);
  mismatches.push({ label, details: details || [] });
  return false;
}

// -----------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------

const pluginJson = parseJson("plugin.json");
const readme = read("README.md");
const apiDoc = read("docs/API.md");
const capabilitiesDoc = read("docs/CAPABILITIES.md");
const securityDoc = read("references/SECURITY-NOTES.md");
const routerSrc = read("server/router.js");
const configSrc = read("server/lib/config.js");

// -----------------------------------------------------------------------
// Check 1: every plugin.json capability is mentioned in README.md and
//          in docs/CAPABILITIES.md at least once.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[1/6]")} plugin.json → README.md + docs/CAPABILITIES.md`);
const caps = (pluginJson.extensions?.capabilities ?? [])
  .map((c) => (typeof c === "string" ? c : c.name))
  .filter(Boolean);

if (caps.length === 0) {
  check(
    "plugin.json capabilities list is non-empty",
    false,
    ["plugin.json has zero capabilities; manifest is invalid"],
  );
}

for (const cap of caps) {
  const inReadme = readme.includes(cap);
  const inCapabilities = capabilitiesDoc.includes(cap);
  check(
    `capability "${cap}" appears in README.md`,
    inReadme,
    [`README.md does not mention the capability "${cap}"`],
  );
  check(
    `capability "${cap}" appears in docs/CAPABILITIES.md`,
    inCapabilities,
    [`docs/CAPABILITIES.md does not mention the capability "${cap}"`],
  );
}

// -----------------------------------------------------------------------
// Check 2: every README.md endpoint reference resolves in server/router.js.
//
// We extract `\`\`METHOD /api/path\`\``-style references from README. The
// "Configuration" / "Endpoints" sections of README point to docs/API.md
// for the canonical list; we only assert on what README itself mentions.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[2/6]")} README.md endpoint mentions → server/router.js`);
const readmeEndpoints = [
  ...readme.matchAll(/`(GET|POST|DELETE|PUT|PATCH)\s+(\/api\/[A-Za-z0-9_\-\/:.]+)`/g),
].map((m) => ({ method: m[1], path: m[2].split("?")[0] }));

if (readmeEndpoints.length === 0) {
  console.log(`  ${TAG.dim("(no inline endpoint references found — skip)")}`);
}

for (const { method, path } of readmeEndpoints) {
  // Escape regex metacharacters in the path string.
  const escPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routeRegex = new RegExp(
    `\\bmethod:\\s*["']${method}["']`, // method on a route entry
  );
  // The router also matches by literal `match:` arrow; we look for the
  // method field as a coarse filter, then for the pathname literal.
  const methodMatch = routeRegex.test(routerSrc);
  const pathMatch = pathMatches(path, routerSrc);
  check(
    `README endpoint ${method} ${path} is registered in server/router.js`,
    methodMatch && pathMatch,
    [
      methodMatch
        ? null
        : `server/router.js has no route entry with method "${method}"`,
      pathMatch
        ? null
        : `server/router.js has no match for pathname "${path}"`,
    ].filter(Boolean),
  );
}

// -----------------------------------------------------------------------
// Check 3: every endpoint documented in docs/API.md resolves in
//          server/router.js.
//
// API.md uses the form `### \`METHOD /api/path\`` for each entry; we
// scan those and assert each (method, path) is wired up in router.js.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[3/6]")} docs/API.md endpoints → server/router.js`);
const apiEndpoints = [
  ...apiDoc.matchAll(/### `((?:GET|POST|DELETE|PUT|PATCH)(?:\s*\|\s*(?:GET|POST|DELETE|PUT|PATCH))*) (\/api\/[^`?]+)/g),
].map((m) => {
  const methods = m[1].split("|").map((s) => s.trim());
  const path = m[2].trim();
  return { methods, path };
});

// Also pick up the loose combined headings like
//   ### `GET /api/usage` and `POST /api/usage` and `POST /api/usage-trigger`
// which the regex above will only catch the first verb for; we add a
// fallback pass to handle the "and" form.
const apiEndpointsCombined = [
  ...apiDoc.matchAll(
    /### `((?:GET|POST|DELETE|PUT|PATCH)(?:\/api\/[^`]+` and `)?(?:GET|POST|DELETE|PUT|PATCH)?(?:\/api\/[^`]+`)?(?: and `(?:GET|POST|DELETE|PUT|PATCH) \/api\/[^`]+`)*)/g,
  ),
].map(() => null); // signal — handled below by a smarter extractor

// Helper: every path literal that appears inside a `### \`...\`` heading.
const headingEndpoints = [];
for (const m of apiDoc.matchAll(/^### `([^`]+)`/gm)) {
  const inner = m[1];
  // Split on " and " / "|" — API.md mixes both styles.
  const parts = inner.split(/\s+and\s+|\s*\|\s*/);
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) continue;
    const mm = part.match(
      /^(GET|POST|DELETE|PUT|PATCH)\s+(\/api\/[A-Za-z0-9_\-\/:.]+)/,
    );
    if (mm) headingEndpoints.push({ method: mm[1], path: mm[2] });
  }
}

if (headingEndpoints.length === 0) {
  check(
    "docs/API.md has at least one ### `METHOD /api/...` heading",
    false,
    ["no endpoint headings found — the docs may be malformed"],
  );
}

for (const { method, path } of headingEndpoints) {
  // Collapse `?query` for matching — router matchers strip the query.
  const basePath = path.split("?")[0];
  const hasMethod = new RegExp(
    `\\bmethod:\\s*["']${method}["']`,
  ).test(routerSrc);
  const pathMatch = pathMatches(basePath, routerSrc);
  const ok = hasMethod && pathMatch;
  check(
    `docs/API.md endpoint ${method} ${basePath} is registered in server/router.js`,
    ok,
    [
      hasMethod
        ? null
        : `server/router.js has no route entry with method "${method}"`,
      pathMatch
        ? null
        : `server/router.js has no match for pathname "${basePath}"`,
    ].filter(Boolean),
  );
}

// -----------------------------------------------------------------------
// Check 4: every env var mentioned in references/SECURITY-NOTES.md is
//          exported by server/lib/config.js.
//
// SECURITY-NOTES is the canonical disclosure; it lists the env vars
// the plugin reads. If it mentions one that config.js doesn't export,
// the docs are lying about what the plugin actually does.
// -----------------------------------------------------------------------

// Known env vars documented in SECURITY-NOTES.md (and the README /
// API.md). Keep this list explicit — heuristics over the prose are
// fragile and we'd rather under-report than over-report.
const KNOWN_ENV_VARS = new Set([
  "TOKEN",
  "HOST",
  "PORT",
  "MCODE_CMD",
  "MCODE_MODEL",
  "MCODE_WORKSPACE",
  "MCODE_TIMEOUT",
  "MCODE_MAX_STEPS",
  "MCODE_MAX_CONCURRENT",
  "MCODE_RUNTIME_DB",
  "MCODE_WEBUI_UPLOAD_DIR",
  "MCODE_WEBUI_SETTINGS_PATH",
  "MCODE_WEBUI_SESSIONS_DB",
  "MCODE_BETTER_SQLITE3",
  "MAVIS_DATA_DIR",
  "SQLITE3_BIN",
  "DEBUG_INJECT",
]);

console.log(`${TAG.dim("[4/6]")} references/SECURITY-NOTES.md env vars → server/lib/config.js`);
// Env-var tokens in SECURITY-NOTES are mostly `TOKEN`, `HOST`, `PORT`,
// `MCODE_RUNTIME_DB`, `MCODE_WEBUI_UPLOAD_DIR`, `MCODE_WEBUI_SETTINGS_PATH`,
// `MAVIS_DATA_DIR`, `MCODE_MODEL`, `MCODE_CMD`, `MCODE_WORKSPACE`,
// `MCODE_BETTER_SQLITE3`, `DEBUG_INJECT`, `MCODE_TIMEOUT`,
// `MCODE_MAX_STEPS`, `MCODE_MAX_CONCURRENT`, `SQLITE3_BIN`.
// Match any SCREAMING_SNAKE_CASE identifier of length ≥ 4 that isn't
// part of a code-fence block.
const envVarPattern = /\b([A-Z][A-Z0-9_]{3,})\b/g;
const envVars = new Set();
for (const m of securityDoc.matchAll(envVarPattern)) {
  // Skip obvious non-env matches: `MIT`, `URL`, `JSON`, `JSONRPC`,
  // `BOM`, `UTF`, `SQL`, `API`, `HTTP`, `SSE`, `POST`, `GET`,
  // `DELETE`, `OPTIONS`, `LAN`, `UI`, `JS`, `CSS`, `HTML`, `OS`,
  // `Node`, `URL`. We only care about vars we know the plugin reads.
  const v = m[1];
  if (KNOWN_ENV_VARS.has(v)) envVars.add(v);
}

for (const v of envVars) {
  // config.js exports the variable as either `export const FOO` or
  // `export const FOO_BAR`. Accept either.
  const exported = new RegExp(
    `export\\s+const\\s+${v}\\b`,
  ).test(configSrc);
  check(
    `SECURITY-NOTES env var "${v}" is exported by server/lib/config.js`,
    exported,
    [`server/lib/config.js has no \`export const ${v}\``],
  );
}

if (envVars.size === 0) {
  console.log(`  ${TAG.dim("(no env vars detected in SECURITY-NOTES.md — skip)")}`);
}

// -----------------------------------------------------------------------
// Check 5: plugin.json round-trip parse + capability shape.
// (We re-parse plugin.json — a cheap belt-and-braces assertion that the
// manifest is JSON-clean. Already done implicitly by parseJson() above.)
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[5/6]")} plugin.json round-trip parse + capability shape`);
const capsObjects = pluginJson.extensions?.capabilities ?? [];
check(
  "plugin.json round-trip JSON parse",
  true,
  [],
);
check(
  "every plugin.json capability is an object with name + description",
  capsObjects.length > 0 &&
    capsObjects.every(
      (c) =>
        typeof c === "object" &&
        typeof c.name === "string" &&
        c.name.length > 0 &&
        typeof c.description === "string" &&
        c.description.length >= 30,
    ),
  capsObjects.length === 0
    ? ["no capabilities defined"]
    : capsObjects
        .filter(
          (c) =>
            !c ||
            typeof c.name !== "string" ||
            c.name.length === 0 ||
            typeof c.description !== "string" ||
            c.description.length < 30,
        )
        .map(
          (c) =>
            `capability ${JSON.stringify(c)} missing name or has description < 30 chars`,
        ),
);

// -----------------------------------------------------------------------
// Check 6: docs/ANTI-PATTERNS-FIX-PLAN.md §AP11 known drift — assert
//          there is no `cleanup-orphans` endpoint in docs/API.md that
//          is missing from server/router.js (or vice-versa).
//
// This is the specific drift the anti-pattern doc calls out; the
// check makes it mechanical so future PRs can't reintroduce the same
// bug silently.
// -----------------------------------------------------------------------

console.log(`${TAG.dim("[6/6]")} known drift: cleanup-orphans endpoint consistency`);
const apiHasCleanup = apiDoc.includes("cleanup-orphans");
const routerHasCleanup = /method:\s*["'](?:GET|POST|DELETE)["'][^}]*cleanup-orphans/.test(
  routerSrc,
);
if (apiHasCleanup && !routerHasCleanup) {
  check(
    "docs/API.md does NOT document a missing endpoint (cleanup-orphans)",
    false,
    [
      "docs/API.md mentions POST /api/sessions/cleanup-orphans but server/router.js has no route for it",
      "Either delete the docs/API.md entry or add the route (see docs/ANTI-PATTERNS-FIX-PLAN.md §AP11)",
    ],
  );
} else if (!apiHasCleanup && routerHasCleanup) {
  check(
    "server/router.js does NOT expose an undocumented endpoint (cleanup-orphans)",
    false,
    [
      "server/router.js has a cleanup-orphans route that is not documented in docs/API.md",
      "Either remove the route or add the docs/API.md entry",
    ],
  );
} else {
  check(
    "cleanup-orphans endpoint is consistent between docs/API.md and server/router.js",
    true,
    [],
  );
}

// -----------------------------------------------------------------------
// Summary + exit code
// -----------------------------------------------------------------------

console.log("");
if (mismatches.length === 0) {
  console.log(`${TAG.green("OK")} all checks passed.`);
  process.exit(0);
} else {
  console.log(
    `${TAG.red("FAIL")} ${mismatches.length} check group(s) reported mismatches.`,
  );
  process.exit(1);
}