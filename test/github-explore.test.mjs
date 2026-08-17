import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(
  here, "..", "plugins", "Fectivnfy112357", "github-explore",
  "skills", "github-explore", "scripts",
);
test("github-explore Python regression tests", (context) => {
  const python = findPython();
  if (!python) {
    context.skip("python is not available on this machine");
    return;
  }
  const r = spawnSync(
    python,
    ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
    { cwd: scripts, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(
    r.status, 0,
    "python tests failed (status " + r.status + ")\n--- stdout ---\n" + r.stdout + "\n--- stderr ---\n" + r.stderr,
  );
});

function findPython() {
  const candidates = process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"];
  for (const name of candidates) {
    const probe = spawnSync(name, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.status === 0 && !probe.error) return name;
  }
  return null;
}
