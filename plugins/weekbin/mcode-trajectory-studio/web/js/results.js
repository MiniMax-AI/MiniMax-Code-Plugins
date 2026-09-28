/**
 * Tool-result interpretation.
 *
 * A non-zero exit code is not by itself a problem — `grep` returns 1 for "no
 * matches" — so the reader is shown the raw evidence (exit code, stderr,
 * traceback, the runtime's own is_error flag) instead of a verdict. `severity`
 * separates a hard failure from a soft one; the UI labels both accordingly.
 */

export function toolFailed(call) {
  return call.ok === false || call.taskStatus === 'failed';
}

/**
 * Flatten a tool result into text plus an honest failure classification.
 */
export function parseResult(result) {
  const empty = { text: '', failed: false, severity: null, signal: null, exitCode: null, isError: false, details: null };
  if (result === null || result === undefined) return empty;

  let value = result;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      const text = String(result);
      return classifyResult(text, null);
    }
  }
  if (value && typeof value === 'object') {
    const parts = [];
    if (Array.isArray(value.content)) {
      for (const item of value.content) {
        if (typeof item?.text === 'string') parts.push(item.text);
      }
    }
    if (typeof value.text === 'string') parts.push(value.text);
    if (typeof value.error === 'string') parts.push(value.error);
    return classifyResult(parts.join('\n'), value.details && typeof value.details === 'object' ? value.details : null);
  }
  return classifyResult(String(value), null);
}

export function classifyResult(text, details) {
  const exitCode = Number(text.match(/Command exited with code (-?\d+)/)?.[1] ?? NaN);
  const isError = details?.is_error === true || details?.isError === true;
  const status = typeof details?.status === 'string' ? details.status : null;
  const hasTraceback = /Traceback \(most recent call last\)/.test(text);
  const hasStderr = /\[stderr\]/.test(text);

  let severity = null;
  let signal = null;
  if (hasTraceback) { severity = 'hard'; signal = 'Traceback'; }
  else if (hasStderr) { severity = 'hard'; signal = 'stderr'; }
  else if (isError || status === 'failed') { severity = 'hard'; signal = '运行时报错'; }
  else if (Number.isFinite(exitCode) && exitCode !== 0) {
    // Soft: the command ran and reported a non-zero status. Frequently benign.
    severity = 'exit';
    signal = `退出码 ${exitCode}`;
  }

  return {
    text,
    failed: severity !== null,
    severity,
    signal,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    isError,
    details,
  };
}

/** Show the part of a result that explains the failure, not the head of the log. */
export function failureExcerpt(text) {
  const lines = text.split('\n');
  const anchor = lines.findIndex((line) => /Traceback \(most recent call last\)|\[stderr\]|^\s*(Error|Exception):|\bFATAL\b/i.test(line));
  if (anchor === -1) return lines.slice(0, 40).join('\n');
  return lines.slice(Math.max(0, anchor - 2), anchor + 38).join('\n');
}
