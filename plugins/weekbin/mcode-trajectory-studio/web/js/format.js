/**
 * Presentation helpers: number and time formatting, DOM node construction, and
 * the two truncators the stream and inspector render with. Leaf module with no
 * dependency on state.
 */

export function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  let minutes = Math.floor(ms / 60_000);
  let seconds = Math.round((ms % 60_000) / 1000);
  // Rounding can land on 60s (e.g. 142m59.6s); carry it instead of printing "142m60s".
  if (seconds === 60) {
    seconds = 0;
    minutes += 1;
  }
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function fmtTokens(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function fmtClock(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

export function fmtFull(ms) {
  if (!ms) return '—';
  const date = new Date(ms);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function fmtAge(ms) {
  if (!ms) return '';
  const delta = Date.now() - ms;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function shortId(id) {
  return typeof id === 'string' ? id.replace(/^mvs_/, '').slice(0, 10) : '—';
}

export function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function oneLine(value, limit = 260) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Pretty-print a JSON string or value, falling back to the raw input. */
export function prettyJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Pull a readable one-liner out of a tool payload. */
export function payloadPreview(args) {
  if (args === null || args === undefined) return '';
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return oneLine(value, 200);
    }
  }
  if (value && typeof value === 'object') {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'objective', 'description', 'name']) {
      if (typeof value[key] === 'string' && value[key]) return oneLine(value[key], 200);
    }
    const keys = Object.keys(value);
    if (keys.length) return oneLine(`${keys[0]}: ${JSON.stringify(value[keys[0]])}`, 200);
  }
  return oneLine(JSON.stringify(value), 200);
}
