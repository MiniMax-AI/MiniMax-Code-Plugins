/**
 * The "Agent 与能力" panel: what a session was configured with.
 *
 * The runtime only records an agent definition for preset and sub-agent sessions,
 * so absence is explained rather than left blank.
 */

import { el, state } from './state.js';
import { fmtTokens, textNode } from './format.js';

export function renderCapability(agent) {
  const body = el('cap-body');
  body.textContent = '';
  state.agent = agent;

  if (!agent) {
    el('cap-summary').textContent = '该会话未记录 Agent 定义';
    body.append(textNode('p', 'muted small',
      '运行时只为预设或子代理会话写入 Agent 定义（模型、工具白名单、技能、系统提示）。本会话没有这条记录。'));
    return;
  }

  const model = agent.model ?? {};
  el('cap-summary').textContent =
    `${agent.ownerName ?? '—'} · ${model.modelId ?? '—'} · 工具 ${agent.tools.length} · 技能 ${agent.skills.length + agent.extensionSkills.length}`;

  const grid = textNode('div', 'cap-grid');
  const group = (title, rows) => {
    const card = textNode('div', 'cap-card');
    card.append(textNode('h4', '', title));
    const dt = document.createElement('dl');
    dt.className = 'kv';
    for (const [key, value] of rows) {
      if (value === null || value === undefined || value === '') continue;
      dt.append(textNode('dt', '', key));
      dt.append(textNode('dd', '', String(value)));
    }
    card.append(dt);
    return card;
  };

  grid.append(group('模型', [
    ['provider', model.providerId],
    ['model', model.modelId],
    ['variant', model.variant],
    ['上下文窗口', model.contextWindow ? fmtTokens(model.contextWindow) : null],
    ['最大输出', model.maxOutputTokens ? fmtTokens(model.maxOutputTokens) : null],
    ['参数快照', model.parameterSnapshot ? JSON.stringify(model.parameterSnapshot) : null],
  ]));

  grid.append(group('能力', [
    ['工具白名单', agent.tools.join(', ') || '（无）'],
    ['禁用工具', agent.disallowedTools.join(', ')],
    ['MCP 服务', agent.mcpServers.join(', ')],
    ['定义版本', agent.definitionVersion],
  ]));
  body.append(grid);

  if (agent.skills.length || agent.extensionSkills.length) {
    const card = textNode('div', 'cap-card cap-wide');
    card.append(textNode('h4', '', `技能 (${agent.skills.length} 内置 / ${agent.extensionSkills.length} 扩展)`));
    const list = textNode('div', 'cap-chips');
    for (const skill of agent.skills) list.append(textNode('span', 'tool-tag', skill));
    for (const skill of agent.extensionSkills) list.append(textNode('span', 'tool-tag is-ext', skill));
    card.append(list);
    body.append(card);
  }

  if (agent.systemPrompt) {
    const card = textNode('div', 'cap-card cap-wide');
    card.append(textNode('h4', '', '系统提示'));
    card.append(textNode('pre', 'block', agent.systemPrompt));
    body.append(card);
  }
}
