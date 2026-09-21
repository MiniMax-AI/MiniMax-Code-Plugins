// webui/server/lib/feedback/command-feedback.js
// Feedback emission for slash commands. Owns the feedback line format
// appended to chat after a command executes. Closes the command-
// feedback seam from BORROW-dsh-deepseek-harness-2026-08-28 § 3.
//
// All writes route through state-bus.pushStateFor (no direct SSE).
// Future Borrow 1 (transcript) + Borrow 3 (hook seam) call sites can
// intercept emitCommandFeedback rather than touching every command
// body in interaction/commands.js.

import { pushStateFor } from "../state-bus.js";

const FEEDBACK_PREFIX = "›";

// formatCommandFeedback — pure: produce the rendered feedback string.
//   cmd:    the slash command (with or without leading /)
//   ok:     whether the command succeeded
//   detail: optional short reason (e.g. "noop-empty", "running")
export function formatCommandFeedback(cmd, ok, detail) {
  const raw = String(cmd || "");
  const name = raw.startsWith("/") ? raw : `/${raw}`;
  if (ok === false) {
    return detail
      ? `! [${name} failed] ${detail}`
      : `! [${name} failed]`;
  }
  if (detail) {
    return `● ${name} ok (${detail})`;
  }
  return `● ${name} ok`;
}

// emitCommandFeedback — append a feedback line to cs.chat and push state.
//   All writes route through state-bus.pushStateFor.
//   Returns the formatted line.
export function emitCommandFeedback(cs, cid, cmd, ok, detail) {
  const line = formatCommandFeedback(cmd, ok, detail);
  cs.chat = [...(cs.chat || []), `${FEEDBACK_PREFIX} ${line}`];
  pushStateFor(cid);
  return line;
}