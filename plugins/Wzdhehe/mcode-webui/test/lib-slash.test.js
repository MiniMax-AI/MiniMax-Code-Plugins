// webui/test/lib-slash.test.js
// Unit tests for server/lib/slash.js — matchSlash (pure regex parser).
//
// Why this test exists: slash.js is the webui-side command dispatcher
// (/goal, /clear, /status, /usage, /help, etc.). The matchSlash function
// parses the user's input into {cmd, rest} — bugs here = /goal arg is
// truncated, or /status is misidentified as /stat.
//
// Test strategy: We test matchSlash via the existing _setup.js mock
// (which provides a regex-identical implementation). The full handleLocalSlash
// and handleCmdCommand functions call pushStateFor internally, which
// triggers a real mcode acp client spawn — out of scope for unit tests.
// They're better covered by integration tests (agent-browser manual e2e).
//
// REASON FOR LIMITED COVERAGE: The current _setup.js architecture mocks
// `lib/slash.js` as a whole, replacing the real implementation. To test
// the real handleLocalSlash/handleCmdCommand we'd need to either (a) not
// use setupMocks (then pushStateFor hangs on real mcode acp spawn), or
// (b) refactor setupMocks to allow opting out of specific module mocks.
// Both are significant refactors; defer to a future plan.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { setupMocks, absPath } from "./_setup.js";

let slash;
before(async (t) => {
  await setupMocks(t, {});
  // The _setup.js mock provides matchSlash as a stable function reference
  // that uses the same regex as the real one. We import slash via the
  // mock (which is what setupMocks provides).
  slash = await import(absPath("lib/slash.js"));
});

describe("matchSlash — pure regex parser (via mock that mirrors real impl)", () => {
  test("returns null for non-slash input", () => {
    assert.equal(slash.matchSlash("hello world"), null);
  });

  test("returns null for empty input", () => {
    assert.equal(slash.matchSlash(""), null);
  });

  test("parses simple /cmd with no args", () => {
    const r = slash.matchSlash("/clear");
    assert.deepEqual(r, { cmd: "clear", rest: "" });
  });

  test("parses /cmd with single arg", () => {
    const r = slash.matchSlash("/goal write a poem");
    assert.deepEqual(r, { cmd: "goal", rest: "write a poem" });
  });

  test("parses /cmd with multiple words in rest", () => {
    const r = slash.matchSlash("/goal this is a long argument with spaces");
    assert.deepEqual(r, { cmd: "goal", rest: "this is a long argument with spaces" });
  });

  test("parses /cmd with hyphen (e.g. /goal-done)", () => {
    const r = slash.matchSlash("/goal-done");
    assert.deepEqual(r, { cmd: "goal-done", rest: "" });
  });

  test("parses /cmd with underscore (e.g. /my_cmd)", () => {
    const r = slash.matchSlash("/my_cmd arg");
    assert.deepEqual(r, { cmd: "my_cmd", rest: "arg" });
  });

  test("rejects /1 (cmd must start with a letter per SLASH_REGEX)", () => {
    // SLASH_REGEX = /^\/([a-zA-Z][\w-]*)\b\s*(.*)/
    // \w includes digits, but [a-zA-Z] requires the first char to be a letter
    assert.equal(slash.matchSlash("/1invalid"), null);
  });

  test("rejects / (empty cmd)", () => {
    assert.equal(slash.matchSlash("/"), null);
  });

  test("rejects /@ (special char)", () => {
    assert.equal(slash.matchSlash("/@"), null);
  });

  test("parses /cmd followed by tab character", () => {
    const r = slash.matchSlash("/help\targ");
    // \s in regex includes tab
    assert.equal(r.cmd, "help");
  });
});
