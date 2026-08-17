/**
 * Minimal .gitignore matcher for the code index walker.
 *
 * Supports the most common gitignore semantics: blank lines and `#` comments,
 * `!` negation, trailing `/` directory patterns, leading `/` anchors, globs
 * (`*`, `**`, `?`, `[...]`), and the rule that a pattern containing a slash is
 * anchored to the repository root while a slash-less pattern matches any
 * basename. The last matching rule wins, matching git behavior.
 */

export function parseGitignore(text) {
  const rules = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1).trim();
    }
    if (!line || line.startsWith('#')) continue;
    const isDir = line.endsWith('/');
    if (isDir) line = line.slice(0, -1);
    let anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const hasSlash = line.includes('/');
    let source = translateGlob(line);
    if (isDir) source += '(?:/.*)?';
    if (anchored || hasSlash) source = `^${source}$`;
    else source = `(?:^|.*/)${source}$`;
    rules.push({ negated, re: new RegExp(source) });
  }
  return rules;
}

export function isIgnored(relPath, rules) {
  if (!rules.length) return false;
  const normalized = relPath.replace(/\\/g, '/');
  let ignored = false;
  for (const rule of rules) {
    if (rule.re.test(normalized)) ignored = !rule.negated;
  }
  return ignored;
}

function translateGlob(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) out += '\\[';
      else {
        out += pattern.slice(i, end + 1);
        i = end;
      }
    } else {
      out += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return out;
}
