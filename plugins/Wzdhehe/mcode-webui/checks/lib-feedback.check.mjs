// webui/test/lib-feedback.test.js
// Unit tests for server/lib/feedback/* — the 2 feedback modules split
// out of slash.js per BORROW-dsh-deepseek-harness-2026-08-28 § 3:
//   - command-feedback.js (per-cmd feedback line)
//   - message-feedback.js (per-message thumbs up/down)

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { setupMocks, absPath } from "../test/_setup.js";

let cmdFb, msgFb;
before(async (t) => {
  await setupMocks(t, {});
  cmdFb = await import(absPath("lib/feedback/command-feedback.js"));
  msgFb = await import(absPath("lib/feedback/message-feedback.js"));
});

function fakeCs() {
  return {
    chat: [],
    messageFeedback: undefined, // lazy-init
  };
}

// ---------------------------------------------------------------------
// command-feedback.js
// ---------------------------------------------------------------------
describe("command-feedback — per-cmd feedback line", () => {
  test("formatCommandFeedback: ok with no detail", () => {
    assert.equal(cmdFb.formatCommandFeedback("/help", true), "● /help ok");
  });
  test("formatCommandFeedback: ok with detail", () => {
    assert.equal(
      cmdFb.formatCommandFeedback("/new", true, "noop-empty"),
      "● /new ok (noop-empty)",
    );
  });
  test("formatCommandFeedback: failed without detail", () => {
    assert.equal(cmdFb.formatCommandFeedback("/stop", false), "! [/stop failed]");
  });
  test("formatCommandFeedback: failed with detail", () => {
    assert.equal(
      cmdFb.formatCommandFeedback("/stop", false, "running"),
      "! [/stop failed] running",
    );
  });
  test("formatCommandFeedback: cmd without leading slash", () => {
    assert.equal(cmdFb.formatCommandFeedback("help", true), "● /help ok");
  });

  test("emitCommandFeedback appends a chat line and returns the formatted line", () => {
    const cs = fakeCs();
    const line = cmdFb.emitCommandFeedback(cs, "cid-1", "/help", true);
    assert.equal(cs.chat.length, 1);
    assert.equal(cs.chat[0], `› ${line}`);
    assert.equal(line, "● /help ok");
  });
});

// ---------------------------------------------------------------------
// message-feedback.js
// ---------------------------------------------------------------------
describe("message-feedback — thumbs up/down per message", () => {
  test("MESSAGE_FEEDBACK_VALUES enum is frozen", () => {
    assert.equal(msgFb.MESSAGE_FEEDBACK_VALUES.UP, "up");
    assert.equal(msgFb.MESSAGE_FEEDBACK_VALUES.DOWN, "down");
    assert.equal(msgFb.MESSAGE_FEEDBACK_VALUES.NONE, "none");
    assert.throws(() => {
      msgFb.MESSAGE_FEEDBACK_VALUES.NEW = "new";
    }, TypeError);
  });

  test("setMessageFeedback records up/down and clears on 'none'", () => {
    const cs = fakeCs();
    assert.equal(
      msgFb.setMessageFeedback(cs, "cid-1", 0, msgFb.MESSAGE_FEEDBACK_VALUES.UP),
      "up",
    );
    assert.equal(
      msgFb.getMessageFeedback(cs, 0),
      msgFb.MESSAGE_FEEDBACK_VALUES.UP,
    );

    msgFb.setMessageFeedback(cs, "cid-1", 0, msgFb.MESSAGE_FEEDBACK_VALUES.NONE);
    assert.equal(
      msgFb.getMessageFeedback(cs, 0),
      msgFb.MESSAGE_FEEDBACK_VALUES.NONE,
    );
  });

  test("setMessageFeedback ignores unknown values", () => {
    const cs = fakeCs();
    const r = msgFb.setMessageFeedback(cs, "cid-1", 0, "sideways");
    assert.equal(r, msgFb.MESSAGE_FEEDBACK_VALUES.NONE);
    assert.equal(
      msgFb.getMessageFeedback(cs, 0),
      msgFb.MESSAGE_FEEDBACK_VALUES.NONE,
    );
  });

  test("listMessageFeedback returns plain object snapshot", () => {
    const cs = fakeCs();
    msgFb.setMessageFeedback(cs, "cid-1", 1, msgFb.MESSAGE_FEEDBACK_VALUES.UP);
    msgFb.setMessageFeedback(cs, "cid-1", 2, msgFb.MESSAGE_FEEDBACK_VALUES.DOWN);
    const snap = msgFb.listMessageFeedback(cs);
    assert.deepEqual(snap, { 1: "up", 2: "down" });
    // ensure it's a plain object, not a live Map
    assert.ok(!(snap instanceof Map));
  });

  test("countMessageFeedback tallies up/down", () => {
    const cs = fakeCs();
    msgFb.setMessageFeedback(cs, "cid-1", 1, msgFb.MESSAGE_FEEDBACK_VALUES.UP);
    msgFb.setMessageFeedback(cs, "cid-1", 2, msgFb.MESSAGE_FEEDBACK_VALUES.UP);
    msgFb.setMessageFeedback(cs, "cid-1", 3, msgFb.MESSAGE_FEEDBACK_VALUES.DOWN);
    assert.deepEqual(msgFb.countMessageFeedback(cs), { up: 2, down: 1, total: 3 });
  });

  test("formatMessageFeedbackIcon renders 👍/👎/empty", () => {
    assert.equal(
      msgFb.formatMessageFeedbackIcon(msgFb.MESSAGE_FEEDBACK_VALUES.UP),
      "👍",
    );
    assert.equal(
      msgFb.formatMessageFeedbackIcon(msgFb.MESSAGE_FEEDBACK_VALUES.DOWN),
      "👎",
    );
    assert.equal(
      msgFb.formatMessageFeedbackIcon(msgFb.MESSAGE_FEEDBACK_VALUES.NONE),
      "",
    );
  });
});