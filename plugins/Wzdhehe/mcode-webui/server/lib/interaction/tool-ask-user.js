// webui/server/lib/interaction/tool-ask-user.js
// Per-tool ask dialog seam. Owns the `cs.ask` state shape used by the
// AskUser tool modal in the webui. Closes the tool-ask-user seam from
// BORROW-dsh-deepseek-harness-2026-08-28 § 3 and is the foundation
// for ANTI-PATTERNS-FIX-PLAN.md §AP10 (slash governance UI gate).
//
// NOTE: the `cs.ask` state is currently mutated by mcode-acp.js
// stream code paths; this module provides the helper API so future
// Borrow 1 (transcript) and Borrow 3 (hook seam) call sites can
// route through one chokepoint. SSE writes always go via
// state-bus.pushStateFor — no direct SSE writes from here.

import { pushStateFor } from "../state-bus.js";

// Canonical ask state shape (ARCHITECTURE.md §4). All fields present
// even when inactive so consumers never see `undefined`.
export function makeAskState() {
  return {
    active: false,
    total: 0,
    answered: 0,
    currentIdx: 0,
    question: "",
    options: [],
  };
}

// setAskPending — populate cs.ask with a new ask payload and push state.
//   payload: { questions: Array<{header,question,options,multiSelect}> }
//     per ARCHITECTURE.md §5 (ask event).
//   Returns true on success, false when payload is empty or cs missing.
export function setAskPending(cs, cid, payload) {
  if (!cs) return false;
  const questions = Array.isArray(payload?.questions)
    ? payload.questions
    : [];
  if (questions.length === 0) return false;
  const first = questions[0] || {};
  cs.ask = {
    active: true,
    total: questions.length,
    answered: 0,
    currentIdx: 0,
    question: first.question || "",
    options: Array.isArray(first.options) ? first.options : [],
  };
  pushStateFor(cid);
  return true;
}

// clearAskPending — close the ask modal. Idempotent (no-op if inactive).
export function clearAskPending(cs, cid) {
  if (!cs || !cs.ask) return;
  cs.ask = { ...cs.ask, active: false };
  pushStateFor(cid);
}

// isAskPending — convenience predicate so callers don't poke cs.ask.active.
export function isAskPending(cs) {
  return !!(cs && cs.ask && cs.ask.active);
}

// recordAskProgress — mark the current question answered and advance idx.
//   Returns the next currentIdx, or total when all answered.
export function recordAskProgress(cs) {
  if (!cs || !cs.ask || !cs.ask.active) return 0;
  const next = cs.ask.currentIdx + 1;
  const done = next >= cs.ask.total;
  cs.ask = {
    ...cs.ask,
    answered: cs.ask.answered + 1,
    currentIdx: done ? cs.ask.currentIdx : next,
    active: !done,
  };
  if (done && cs.ask.nextQuestion) {
    cs.ask.question = cs.ask.nextQuestion;
    cs.ask.options = cs.ask.nextOptions || [];
    cs.ask.nextQuestion = "";
    cs.ask.nextOptions = [];
  }
  return done ? cs.ask.total : next;
}

// hydrateAskFromQuestions — populate cs.ask from a normalized
//   questions list (typically output of user-questions.normalizeQuestions).
//   Peeks ahead so the UI can show the "next" question's preview.
export function hydrateAskFromQuestions(cs, cid, questions) {
  if (!cs) return false;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  const first = questions[0];
  const second = questions[1];
  cs.ask = {
    ...(cs.ask || makeAskState()),
    active: true,
    total: questions.length,
    answered: 0,
    currentIdx: 0,
    question: first.question || "",
    options: Array.isArray(first.options) ? first.options : [],
    nextQuestion: second ? second.question || "" : "",
    nextOptions: second && Array.isArray(second.options) ? second.options : [],
  };
  pushStateFor(cid);
  return true;
}