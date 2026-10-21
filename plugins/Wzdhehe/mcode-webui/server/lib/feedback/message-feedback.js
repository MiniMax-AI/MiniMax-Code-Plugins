// webui/server/lib/feedback/message-feedback.js
// Per-message feedback (thumbs up / down) seam. Provides an in-memory
// feedback store keyed by message index in the current chat. Closes
// the message-feedback seam from BORROW-dsh-deepseek-harness-2026-08-28
// § 3. Persistence (Borrow 1 transcript) is intentionally out of scope
// for this initial split — the store lives on `cs` and is rebuilt
// per-cid on session switch.

import { pushStateFor } from "../state-bus.js";

export const MESSAGE_FEEDBACK_VALUES = Object.freeze({
  UP: "up",
  DOWN: "down",
  NONE: "none",
});

// cs.messageFeedback: shape Map<number, value>. Lazy-init on first
// call so callers can store feedback on an existing cs object without
// explicit setup.
function ensureStore(cs) {
  if (!cs.messageFeedback || !(cs.messageFeedback instanceof Map)) {
    cs.messageFeedback = new Map();
  }
  return cs.messageFeedback;
}

// setMessageFeedback — record (or clear) feedback for a message idx.
//   value: 'up' | 'down' | 'none' — 'none' clears the entry.
//   Unknown values are ignored (returns MESSAGE_FEEDBACK_VALUES.NONE).
export function setMessageFeedback(cs, cid, msgIdx, value) {
  const store = ensureStore(cs);
  if (value === MESSAGE_FEEDBACK_VALUES.NONE) {
    store.delete(msgIdx);
  } else if (
    value === MESSAGE_FEEDBACK_VALUES.UP ||
    value === MESSAGE_FEEDBACK_VALUES.DOWN
  ) {
    store.set(msgIdx, value);
  } else {
    return MESSAGE_FEEDBACK_VALUES.NONE;
  }
  pushStateFor(cid);
  return value;
}

// getMessageFeedback — read feedback for a message idx (returns 'none'
// when no feedback is stored).
export function getMessageFeedback(cs, msgIdx) {
  const store = ensureStore(cs);
  return store.get(msgIdx) || MESSAGE_FEEDBACK_VALUES.NONE;
}

// listMessageFeedback — snapshot all feedback entries as a plain object.
//   Useful for /api/state serialization.
export function listMessageFeedback(cs) {
  const store = ensureStore(cs);
  return Object.fromEntries(store);
}

// countMessageFeedback — quick counts for UI badges.
export function countMessageFeedback(cs) {
  const store = ensureStore(cs);
  let up = 0;
  let down = 0;
  for (const v of store.values()) {
    if (v === MESSAGE_FEEDBACK_VALUES.UP) up++;
    else if (v === MESSAGE_FEEDBACK_VALUES.DOWN) down++;
  }
  return { up, down, total: up + down };
}

// formatMessageFeedbackIcon — pure: render an icon for a feedback value.
export function formatMessageFeedbackIcon(value) {
  if (value === MESSAGE_FEEDBACK_VALUES.UP) return "👍";
  if (value === MESSAGE_FEEDBACK_VALUES.DOWN) return "👎";
  return "";
}