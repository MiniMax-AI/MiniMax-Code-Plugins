// webui/server/lib/interaction/user-questions.js
// Typed question UI seam. Normalizes raw question payloads from the
// AskUser tool / mcode acp "ask" event into canonical {text|choice|
// confirm} forms, validates answers, and formats answers for chat
// display. Closes the user-questions seam from BORROW-dsh-deepseek-
// harness-2026-08-28 § 3.
//
// All exports are pure (no SSE, no state-bus writes) — this is the
// data layer that tool-ask-user.js and the UI both consume.

const QUESTION_KINDS = new Set(["text", "choice", "confirm"]);

// inferKind — pick the canonical kind from a raw question object.
//   Defaults: no options → "text"; 2 options labeled yes/no → "confirm";
//   otherwise 2+ options → "choice". Strings vs objects both accepted
//   (the mcode acp payload uses {label,preview}, some tests use bare
//   strings).
export function inferKind(q) {
  if (!q || typeof q !== "object") return "text";
  const opts = Array.isArray(q.options) ? q.options : [];
  if (opts.length === 0) return "text";
  if (opts.length === 2) {
    const labels = opts.map((o) =>
      typeof o === "string"
        ? o.toLowerCase()
        : (o && o.label ? String(o.label).toLowerCase() : ""),
    );
    if (
      (labels.includes("yes") && labels.includes("no")) ||
      (labels.includes("确认") && labels.includes("取消")) ||
      (labels.includes("ok") && labels.includes("cancel"))
    ) {
      return "confirm";
    }
  }
  return "choice";
}

// normalizeQuestions — convert raw payload questions to canonical form.
//   Accepts either an array directly or {questions: [...]} wrapper
//   (matching the acp "ask" event shape in ARCHITECTURE.md §5).
//   Each canonical question:
//     { kind, header, question, options, multiSelect }
export function normalizeQuestions(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.questions)
      ? raw.questions
      : [];
  return list
    .filter((q) => q && typeof q === "object")
    .map((q) => ({
      kind: QUESTION_KINDS.has(q.kind) ? q.kind : inferKind(q),
      header: q.header || "",
      question: q.question || "",
      options: Array.isArray(q.options)
        ? q.options.map((o) =>
            typeof o === "string"
              ? { label: o }
              : o && o.label
                ? o
                : { label: String(o) },
          )
        : [],
      multiSelect: q.multiSelect === true,
    }));
}

// validateAnswer — check the user answer fits the question's constraints.
//   Returns { ok: true, value } on success or { ok: false, error }.
export function validateAnswer(q, answer) {
  if (!q) return { ok: false, error: "no-question" };
  if (q.kind === "text") {
    if (typeof answer !== "string" || !answer.trim()) {
      return { ok: false, error: "text-required" };
    }
    return { ok: true, value: answer.trim() };
  }
  if (q.kind === "choice") {
    const labels = q.options.map((o) => o.label);
    if (q.multiSelect) {
      const arr = Array.isArray(answer) ? answer : [answer];
      for (const a of arr) {
        if (!labels.includes(a)) return { ok: false, error: "not-in-options" };
      }
      return { ok: true, value: arr };
    }
    if (!labels.includes(answer)) return { ok: false, error: "not-in-options" };
    return { ok: true, value: answer };
  }
  if (q.kind === "confirm") {
    if (
      answer !== true &&
      answer !== false &&
      answer !== "yes" &&
      answer !== "no"
    ) {
      return { ok: false, error: "must-be-bool" };
    }
    return { ok: true, value: answer === true || answer === "yes" };
  }
  return { ok: false, error: "unknown-kind" };
}

// formatAnswerForChat — render an answer for display in the chat log.
export function formatAnswerForChat(q, answer) {
  if (!q) return String(answer ?? "");
  if (q.kind === "text") return `「${answer}」`;
  if (q.kind === "confirm") return answer ? "✅ 是" : "❌ 否";
  if (q.kind === "choice") {
    if (Array.isArray(answer)) {
      return answer.map((a) => `「${a}」`).join(" + ");
    }
    return `「${answer}」`;
  }
  return String(answer ?? "");
}

// splitQuestionsByType — group canonical questions by kind. Useful
//   for staged rendering (text first, then choices, then confirms).
export function splitQuestionsByType(questions) {
  const out = { text: [], choice: [], confirm: [] };
  for (const q of questions) {
    if (out[q.kind]) out[q.kind].push(q);
  }
  return out;
}