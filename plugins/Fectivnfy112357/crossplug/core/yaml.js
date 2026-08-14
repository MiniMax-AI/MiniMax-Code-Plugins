// yaml.js — DSH agent-preset YAML 子集解析与生成（零依赖）
//
// 只覆盖 DSH preset 实际使用的子集：
//   - 顶层标量（name / description / order）
//   - 0 缩进的 `- id: xxx` 行条目，嵌套 `name:` / `group:` / `isolate:` / `disabled:` / `config:`
//   - `config:` 后跟标量、`|-` 字面块、或更深一层的 `- id:` 列表（group 场景）
//   - `!!js` 标签原样保留为字符串
// 不做通用 YAML 解析；遇到不支持的结构抛错并给出行号。

'use strict';

function linesOf(text) {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function indentOf(line) {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

function stripComment(line) {
  // 只剥离行首为 '#' 的整行注释，行内注释保留（避免破坏 URL / 内容）
  return line;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('!!js')) return s; // 保留原样
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// 解析一个字面块（`|-` / `|`），返回 { text, nextIndex }
function parseLiteralBlock(lines, startIndex, keyIndent) {
  const out = [];
  let i = startIndex;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    const ind = indentOf(line);
    if (ind <= keyIndent) break;
    out.push(line.slice(Math.min(ind, keyIndent + 2)) === '' ? '' : line.slice(keyIndent + 2));
  }
  // 去掉尾随空行
  while (out.length && out[out.length - 1] === '') out.pop();
  return { text: out.join('\n'), nextIndex: i };
}

// 解析一个条目块（从 `- id:` 行开始到下一个同级 `- id:` 之前）
function parseEntry(lines, startIndex) {
  const entry = { id: '', name: '', disabled: undefined, group: false, isolate: undefined, config: undefined, raw: [] };
  let i = startIndex;
  const keyIndent = indentOf(lines[startIndex]);
  // 收集 raw（原样文本，用于无损复制）
  for (let j = startIndex; j < lines.length; j++) {
    const line = lines[j];
    if (j > startIndex && line.trim() !== '' && indentOf(line) <= keyIndent) break;
    entry.raw.push(line);
  }
  let cursor = startIndex;
  for (; cursor < lines.length; ) {
    const line = lines[cursor];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      cursor++;
      continue;
    }
    const ind = indentOf(line);
    if (ind <= keyIndent && cursor > startIndex) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('- id:')) {
      entry.id = trimmed.slice(5).trim();
      cursor++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!m) {
      throw new Error(`yaml: 无法解析行 ${cursor + 1}: ${line}`);
    }
    const key = m[1];
    const rest = m[2];
    if (rest.startsWith('|-') || rest.startsWith('|')) {
      const block = parseLiteralBlock(lines, cursor + 1, ind);
      entry[key] = block.text;
      cursor = block.nextIndex;
      continue;
    }
    if (rest === '') {
      // 键后跟更深缩进的嵌套块：整块按原文捕获；config 下的 `- id:` 列表做结构化解析
      let j = cursor + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
      if (j < lines.length && indentOf(lines[j]) > ind) {
        if (key === 'config' && lines[j].trim().startsWith('- id:')) {
          const nested = [];
          let k = j;
          let ok = true;
          while (k < lines.length) {
            const l = lines[k];
            if (l.trim() === '') { k++; continue; }
            if (indentOf(l) <= ind) break;
            if (l.trim().startsWith('- id:')) {
              const sub = parseEntry(lines, k);
              nested.push(sub);
              k = sub.nextIndex;
            } else {
              ok = false;
              break;
            }
          }
          if (ok && nested.length) {
            entry.config = { __rows: nested };
            cursor = k;
            continue;
          }
          j = cursor + 1;
          while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
        }
        const blockLines = [];
        while (j < lines.length) {
          const l = lines[j];
          if (l.trim() === '') { blockLines.push(''); j++; continue; }
          if (indentOf(l) <= ind) break;
          blockLines.push(l);
          j++;
        }
        while (blockLines.length && blockLines[blockLines.length - 1] === '') blockLines.pop();
        entry[key] = blockLines.join('\n');
        cursor = j;
        continue;
      }
      entry[key] = '';
      cursor = j;
      continue;
    }
    entry[key] = parseScalar(rest);
    cursor++;
  }
  entry.nextIndex = cursor;
  return entry;
}

// 解析 preset 目录中的两个 YAML 文件
// 返回 { name, description, order, rows: [...], meta: { presetPath, compositionPath } }
function parsePreset(presetYamlText, compositionYamlText, paths = {}) {
  const meta = { presetPath: paths.presetPath, compositionPath: paths.compositionPath };
  const presetInfo = { name: '', description: '', order: undefined };
  if (presetYamlText) {
    for (const line of linesOf(presetYamlText)) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(t);
      if (!m) continue;
      if (m[1] === 'name' || m[1] === 'description' || m[1] === 'order') {
        presetInfo[m[1]] = parseScalar(m[2]);
      }
    }
  }
  const rows = [];
  if (compositionYamlText) {
    const lines = linesOf(compositionYamlText);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (t === '' || t.startsWith('#')) { i++; continue; }
      if (t.startsWith('- id:')) {
        const entry = parseEntry(lines, i);
        rows.push(entry);
        i = entry.nextIndex;
      } else {
        throw new Error(`yaml: 组合文件顶层只支持 '- id:' 条目，行 ${i + 1}: ${line}`);
      }
    }
  }
  return { ...presetInfo, rows, meta };
}

// ── 生成 ────────────────────────────────────────────────────────────────

function q(v) {
  if (typeof v === 'string') {
    if (v === '' || /[:#\[\]{}&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  return String(v);
}

function indentBlock(text, pad) {
  if (!text) return '';
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : pad + l))
    .join('\n');
}

// 生成 preset.yml
function renderPresetYaml({ name, description, order = 90 }) {
  const out = [];
  out.push(`name: ${q(name)}`);
  out.push(`description: ${q(description)}`);
  if (order !== undefined) out.push(`order: ${order}`);
  return out.join('\n') + '\n';
}

// 生成 agent.cordis.yml
// rows: [{ id, name, configText?, configRows?, configScalarList?, disabled? }]
//   configScalarList: { key: string, items: string[] } —— 渲染为 key 下的标量列表（如 customSkillDirs 的 !!js 行）
// headerComment: 字符串或字符串数组
function renderCompositionYaml(rows, headerComment) {
  const out = [];
  if (headerComment) {
    const comments = Array.isArray(headerComment) ? headerComment : String(headerComment).split('\n');
    for (const l of comments) out.push('# ' + l);
    out.push('');
  }
  for (const row of rows) {
    if (row.disabled === true) out.push(`- id: ${row.id}`);
    else out.push(`- id: ${row.id}`);
    out.push(`  name: ${q(row.name)}`);
    if (row.configText !== undefined && row.configText !== null) {
      out.push('  config:');
      out.push('    text: |-');
      out.push(indentBlock(row.configText, '      '));
    } else if (row.configRows && row.configRows.length) {
      out.push('  config:');
      for (const sub of row.configRows) {
        out.push(`    - id: ${sub.id}`);
        if (sub.name) out.push(`      name: ${q(sub.name)}`);
        if (sub.configText !== undefined) {
          out.push('      config:');
          out.push('        text: |-');
          out.push(indentBlock(sub.configText, '          '));
        }
      }
    } else if (row.configScalarList) {
      out.push('  config:');
      out.push(`    ${row.configScalarList.key}:`);
      for (const item of row.configScalarList.items) {
        out.push(`      - ${item}`);
      }
    } else if (row.config !== undefined) {
      out.push(`  config: ${q(row.config)}`);
    }
    if (row.disabled === true) out.push('  disabled: true');
  }
  return out.join('\n') + '\n';
}

module.exports = { parsePreset, renderPresetYaml, renderCompositionYaml, parseScalar, linesOf };
