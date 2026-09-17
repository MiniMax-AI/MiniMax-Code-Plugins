import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

test("PDF runtime skill refuses unsupported accessibility claims", async () => {
  const skill = await readFile(
    path.join(testsRoot, "..", "skills", "document-skills-pdf", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /ReportLab does not produce a tagged PDF\/UA\s+document/);
  assert.match(skill, /do not describe ordinary ReportLab output as accessible or screen-reader-ready/);
  assert.match(skill, /stop and report the limitation/);
  assert.match(skill, /accessible DOCX or HTML/);
});

test("document-skills Python fixtures", { timeout: 12 * 60_000 }, async (context) => {
  for (const name of ["xlsx", "pptx", "pdf", "docx"]) {
    await context.test(name + " fixture", { timeout: 3 * 60_000 }, async () => {
      const scratch = await mkdtemp(path.join(os.tmpdir(), "document-skills-" + name + "-"));
      try {
        await execFileAsync(python, [path.join(testsRoot, name + "_fixture.py")], {
          cwd: scratch,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 170_000,
          windowsHide: true,
        });
      } catch (error) {
        const output = String(error.stdout ?? "") + "\n" + String(error.stderr ?? "");
        assert.fail(name + " fixture failed:\n" + output.slice(-16_000));
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }
});
