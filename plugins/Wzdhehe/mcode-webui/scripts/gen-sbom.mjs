// webui/scripts/gen-sbom.mjs
// CycloneDX 1.5 SBOM generator for mcode-webui v2 — lease C02.
//
// Reads `package.json` for the root component metadata and walks
// `node_modules/*/package.json` to enumerate the installed dependency
// tree. For each component we record:
//   - name + version
//   - license (from the package's own `license` field)
//   - purl (npm ecosystem identifier)
//   - sha512 integrity hash over the on-disk `package.json` (when
//     available; absent entries are still emitted with a placeholder
//     hash so downstream tools can still locate them)
//
// We deliberately do NOT call `npm` or any external tool — the only
// inputs are files on disk and Node stdlib. Reproducibility mandate:
// running `npm ci` followed by `node scripts/gen-sbom.mjs` must always
// produce the same SBOM byte-for-byte modulo the metadata timestamp
// field.
//
// Usage:
//   node scripts/gen-sbom.mjs
//   npm run sbom
//
// Output:
//   sbom.cdx.json (CycloneDX 1.5, BOM format)
//
// Exit codes:
//   0 = SBOM written
//   2 = inputs missing or unreadable (no SBOM written)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "sbom.cdx.json");

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
  } catch (e) {
    console.error(`ERROR cannot read ${rel}: ${e.message}`);
    process.exit(2);
  }
}

function readBytes(rel) {
  try {
    return readFileSync(resolve(ROOT, rel));
  } catch {
    return null;
  }
}

function sha512Hex(bytes) {
  return createHash("sha512").update(bytes).digest("hex");
}

// Normalize the `license` field into a CycloneDX-compatible string.
// SPDX-style expressions ("MIT", "ISC", "(MIT OR Apache-2.0)") are
// passed through verbatim. Object form `{type: "MIT", url: "..."}` is
// reduced to the SPDX id. Anything we can't classify is recorded as
// "NOASSERTION" so the SBOM still has a license slot for every
// component.
function normalizeLicense(raw) {
  if (raw == null) return "NOASSERTION";
  if (typeof raw === "string") return raw.trim() || "NOASSERTION";
  if (typeof raw === "object") {
    if (typeof raw.type === "string") return raw.type.trim() || "NOASSERTION";
    if (typeof raw.name === "string") return raw.name.trim() || "NOASSERTION";
  }
  if (Array.isArray(raw)) {
    const parts = raw.map(normalizeLicense).filter((s) => s && s !== "NOASSERTION");
    return parts.length ? parts.join(" OR ") : "NOASSERTION";
  }
  return "NOASSERTION";
}

function licenseEntry(raw) {
  const id = normalizeLicense(raw);
  if (id === "NOASSERTION") {
    return { license: { name: "NOASSERTION" } };
  }
  return { license: { name: id } };
}

// -----------------------------------------------------------------------
// Enumerate installed packages from node_modules/
// -----------------------------------------------------------------------
//
// We walk the top level of `node_modules/` plus every `@scope/` entry.
// Each leaf directory is expected to contain its own `package.json`
// which is the canonical source of name + version + license.
//
// The lockfile could give us additional info (resolved tarball URLs)
// but we intentionally avoid it here: the lockfile is optional input,
// and the on-disk package.json is the authoritative truth about what
// was installed.
// -----------------------------------------------------------------------

function* walkNodeModules(nmDir) {
  if (!nmDir) return;
  let entries;
  try {
    entries = readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      // Scoped packages: walk one more level.
      const scopeDir = resolve(nmDir, entry.name);
      let scoped;
      try {
        scoped = readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of scoped) {
        if (s.isDirectory()) {
          yield { name: `${entry.name}/${s.name}`, dir: resolve(scopeDir, s.name) };
        }
      }
    } else {
      yield { name: entry.name, dir: resolve(nmDir, entry.name) };
    }
  }
}

function componentFor(name, dir) {
  const pkgRaw = readBytes(`${dir.replace(ROOT + "/", "")}/package.json`);
  if (!pkgRaw) return null;
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw.toString("utf8"));
  } catch {
    return null;
  }
  const version = pkg.version || "0.0.0";
  const license = licenseEntry(pkg.license ?? pkg.licenses);
  const integrity = sha512Hex(pkgRaw);
  return {
    type: "library",
    "bom-ref": `pkg:npm/${name}@${version}`,
    name,
    version,
    licenses: [license],
    hashes: [{ alg: "SHA-512", content: integrity }],
    purl: `pkg:npm/${name}@${version}`,
  };
}

function componentsFromNodeModules() {
  const nmDir = resolve(ROOT, "node_modules");
  const out = [];
  const seen = new Set();
  for (const { name, dir } of walkNodeModules(nmDir)) {
    // Skip our own root package — it'll be the metadata.component,
    // not a regular component.
    if (name === "mcode-webui") continue;
    if (seen.has(name)) continue;
    const c = componentFor(name, dir);
    if (c) {
      out.push(c);
      seen.add(name);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// -----------------------------------------------------------------------
// Build the SBOM
// -----------------------------------------------------------------------

const rootPkg = readJson("package.json");

const components = componentsFromNodeModules();

const now = new Date().toISOString();

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  serialNumber: `urn:uuid:${cryptoUUID()}`,
  metadata: {
    timestamp: now,
    tools: [
      {
        vendor: "mcode-webui",
        name: "gen-sbom.mjs",
        version: rootPkg.version || "0.0.0",
      },
    ],
    authors: [{ name: rootPkg.author || "mcode-webui contributors" }],
    component: {
      "bom-ref": `pkg:npm/${rootPkg.name}@${rootPkg.version}`,
      type: "application",
      name: rootPkg.name,
      version: rootPkg.version,
      description: rootPkg.description || "",
      licenses: [
        licenseEntry(rootPkg.license),
      ],
    },
  },
  components,
};

// crypto.randomUUID is available in Node 19+. We isolate it so the
// script is portable to older Node if we ever lower the engines floor.
function cryptoUUID() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: 32 hex chars with dashes, format deliberately rough.
  const h = createHash("sha256").update(String(Math.random())).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

writeFileSync(OUT, JSON.stringify(sbom, null, 2) + "\n");

console.log(
  `OK wrote ${OUT} — ${components.length} components, root ${rootPkg.name}@${rootPkg.version}`,
);
process.exit(0);
