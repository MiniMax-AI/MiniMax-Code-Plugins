import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 500;
const MAX_RECORDS = 1000;
const EMPTY_BUFFER = Buffer.alloc(0);

export function resolveDataDir(env = process.env, homeDir = os.homedir()) {
  const configured = firstNonEmpty(env.MINIMAX_DATA_DIR, env.MAVIS_DATA_DIR);
  return path.resolve(configured ?? path.join(homeDir, '.minimax'));
}

export async function listMiniMaxSessions({ dataDir = resolveDataDir(), limit = 20 } = {}) {
  const normalizedLimit = boundedInteger(limit, 1, 100, 20);
  const discovery = await discoverSessions(dataDir);
  const available = discovery.sessions.filter((session) => session.ledgerState === 'file');
  return {
    schemaVersion: 1,
    sessions: available.slice(0, normalizedLimit).map((session) => ({
      sessionId: session.sessionId,
      createdAtMs: session.createdAtMs,
      updatedAtMs: session.updatedAtMs,
      source: session.source,
    })),
    returned: Math.min(normalizedLimit, available.length),
    discovered: available.length,
    unavailable: discovery.sessions.length - available.length,
    warnings: discovery.warnings,
  };
}

export async function getMiniMaxTrajectory({
  dataDir = resolveDataDir(),
  sessionId,
  maxRecords = 200,
  detailLevel = 'summary',
} = {}) {
  if (detailLevel !== 'summary' && detailLevel !== 'full') {
    throw new Error('detailLevel must be "summary" or "full"');
  }
  const normalizedMaxRecords = boundedInteger(maxRecords, 50, MAX_RECORDS, 200);
  const discovery = await discoverSessions(dataDir);
  const selected = sessionId
    ? discovery.sessions.find((item) => item.sessionId === sessionId)
    : discovery.sessions.find((item) => item.ledgerState === 'file');
  if (!selected) {
    const suffix = sessionId ? `: ${sessionId}` : '';
    throw new Error(`session_not_found${suffix}`);
  }

  const parsed = await readTrajectoryLedger(selected, normalizedMaxRecords, detailLevel, dataDir);
  const record = parsed.sessionRecord;
  return {
    schemaVersion: 1,
    privacy: {
      detailLevel,
      contentPreviews: detailLevel === 'full',
      previewsAreRedacted: detailLevel === 'full',
      rawRecordsReturned: false,
      thinkingReturned: false,
      toolArgumentsReturned: false,
      toolResultsReturned: false,
      absolutePathsReturned: false,
    },
    session: {
      sessionId: selected.sessionId,
      createdAtMs: selected.createdAtMs,
      updatedAtMs: selected.updatedAtMs,
      source: selected.source,
      ...(record
        ? {
            agentName: stringOrUndefined(record.agentName),
            runtime: stringOrUndefined(record.runtime),
            sessionType: stringOrUndefined(record.sessionType),
            status: stringOrUndefined(record.status),
            archived: typeof record.archived === 'boolean' ? record.archived : undefined,
            ...(detailLevel === 'full'
              ? {
                  titlePreview: previewText(record.title, dataDir),
                  workspaceName: safeBasename(record.workspaceDir),
                }
              : {}),
          }
        : {}),
    },
    summary: parsed.summary,
    events: parsed.events,
    warnings: [...discovery.warnings, ...parsed.warnings],
  };
}

export async function discoverSessions(dataDir) {
  const sessionsRoot = path.join(path.resolve(dataDir), 'v2', 'sessions');
  const warnings = [];
  if (!(await isPlainDirectory(sessionsRoot))) {
    return { sessions: [], warnings: ['sessions_root_missing'] };
  }
  const manifests = [];
  await walkSessionTree(sessionsRoot, 0, manifests, warnings);
  const sessions = [];
  for (const manifestPath of manifests) {
    const session = await readSessionManifest(manifestPath, sessionsRoot, warnings);
    if (session) sessions.push(session);
  }
  sessions.sort(
    (left, right) =>
      right.updatedAtMs - left.updatedAtMs || right.createdAtMs - left.createdAtMs ||
      left.sessionId.localeCompare(right.sessionId),
  );
  return { sessions, warnings: unique(warnings) };
}

async function walkSessionTree(root, depth, manifests, warnings) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    warnings.push('sessions_root_unreadable');
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push('symlink_artifact_rejected');
      continue;
    }
    if (entry.isFile() && entry.name === 'manifest.json' && depth === 4) {
      manifests.push(candidate);
      continue;
    }
    if (entry.isDirectory() && depth < 4) {
      await walkSessionTree(candidate, depth + 1, manifests, warnings);
    }
  }
}

async function readSessionManifest(manifestPath, sessionsRoot, warnings) {
  if (!(await isPlainFile(manifestPath))) {
    warnings.push('symlink_artifact_rejected');
    return undefined;
  }
  const info = await stat(manifestPath);
  if (info.size > MAX_MANIFEST_BYTES) {
    warnings.push('oversized_manifest_ignored');
    return undefined;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    warnings.push('invalid_manifest_ignored');
    return undefined;
  }
  if (!isRecord(manifest) || typeof manifest.sessionId !== 'string' || !manifest.sessionId) {
    warnings.push('invalid_manifest_ignored');
    return undefined;
  }
  const sessionDir = path.dirname(manifestPath);
  if (!isInside(sessionDir, sessionsRoot)) {
    warnings.push('unsafe_manifest_path_ignored');
    return undefined;
  }
  const ledgerPath = path.join(sessionDir, 'ledger.jsonl');
  const ledgerState = await plainFileState(ledgerPath);
  const fallbackMs = info.mtimeMs;
  return {
    sessionId: manifest.sessionId,
    createdAtMs: finiteNumber(manifest.createdAtMs, fallbackMs),
    updatedAtMs: finiteNumber(manifest.updatedAtMs, fallbackMs),
    source: typeof manifest.source === 'string' ? manifest.source : 'unknown',
    sessionDir,
    ledgerPath,
    ledgerState,
  };
}

async function readTrajectoryLedger(session, maxRecords, detailLevel, dataDir) {
  await assertPlainFile(session.ledgerPath);
  const warnings = [];
  const eventCounts = {};
  const eventRing = [];
  const displayMessages = new Map();
  let piMessages = [];
  let totalRecords = 0;
  let sessionRecord;
  let firstEventAtMs;
  let lastEventAtMs;

  for await (const line of boundedJsonlLines(session.ledgerPath, MAX_LINE_BYTES)) {
    if (line.kind === 'oversized') {
      warnings.push('oversized_jsonl_line');
      continue;
    }
    if (!line.text.trim()) continue;
    let event;
    try {
      event = JSON.parse(line.text);
    } catch {
      warnings.push(line.complete ? 'malformed_jsonl_line' : 'incomplete_tail_ignored');
      continue;
    }
    if (!isLedgerEvent(event, session.sessionId)) {
      warnings.push('invalid_ledger_record_ignored');
      continue;
    }
    totalRecords += 1;
    eventCounts[event.kind] = (eventCounts[event.kind] ?? 0) + 1;
    firstEventAtMs = firstEventAtMs === undefined ? event.createdAtMs : Math.min(firstEventAtMs, event.createdAtMs);
    lastEventAtMs = lastEventAtMs === undefined ? event.createdAtMs : Math.max(lastEventAtMs, event.createdAtMs);
    eventRing.push(summarizeEvent(event, detailLevel, dataDir));
    if (eventRing.length > maxRecords) eventRing.shift();

    switch (event.kind) {
      case 'session.created':
      case 'session.metadata_updated':
        if (isRecord(event.record)) sessionRecord = event.record;
        break;
      case 'session.deleted':
        sessionRecord = undefined;
        displayMessages.clear();
        piMessages = [];
        break;
      case 'message.display_upserted':
        if (isRecord(event.message)) {
          const key = typeof event.message.msg_id === 'string'
            ? event.message.msg_id
            : `seq:${String(event.seq)}`;
          displayMessages.set(key, summarizeDisplayMessage(event.message, 'summary', dataDir));
        }
        break;
      case 'message.pi_history_appended':
        if (Array.isArray(event.messages)) {
          piMessages.push(...event.messages.map((message) => summarizePiMessage(message, 'summary', dataDir)));
        }
        break;
      case 'message.pi_history_replaced':
        piMessages = Array.isArray(event.messages)
          ? event.messages.map((message) => summarizePiMessage(message, 'summary', dataDir))
          : [];
        break;
      case 'message.turn_retracted': {
        const removed = new Set(Array.isArray(event.removedDisplayMsgIds) ? event.removedDisplayMsgIds : []);
        for (const key of removed) displayMessages.delete(key);
        piMessages = Array.isArray(event.messages)
          ? event.messages.map((message) => summarizePiMessage(message, 'summary', dataDir))
          : [];
        break;
      }
      case 'message.state_deleted':
        displayMessages.clear();
        piMessages = [];
        break;
    }
  }

  const display = [...displayMessages.values()];
  return {
    sessionRecord,
    events: eventRing,
    warnings: unique(warnings),
    summary: {
      totalRecords,
      returnedRecords: eventRing.length,
      truncated: totalRecords > eventRing.length || warnings.includes('oversized_jsonl_line'),
      firstEventAtMs,
      lastEventAtMs,
      durationMs:
        firstEventAtMs !== undefined && lastEventAtMs !== undefined
          ? Math.max(0, lastEventAtMs - firstEventAtMs)
          : undefined,
      eventCounts,
      finalDisplayMessageCount: display.length,
      finalPiMessageCount: piMessages.length,
      displayToolCallCount: sum(display, 'toolCallCount'),
      piToolCallCount: sum(piMessages, 'toolCallCount'),
      piToolResultCount: piMessages.filter((message) => message.role === 'toolResult').length,
      compactionCount: display.filter((message) =>
        ['compaction', 'compaction_failed', 'compaction_start'].includes(message.messageKind),
      ).length,
      displayUsageTotalTokens: sum(display, 'totalTokens'),
      piUsageTotalTokens: sum(piMessages, 'totalTokens'),
    },
  };
}

function summarizeEvent(event, detailLevel, dataDir) {
  const base = {
    seq: event.seq,
    eventId: event.eventId,
    kind: event.kind,
    createdAtMs: event.createdAtMs,
    ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}),
  };
  switch (event.kind) {
    case 'session.created':
    case 'session.metadata_updated':
      return {
        ...base,
        session: summarizeSessionRecord(event.record, detailLevel, dataDir),
      };
    case 'message.display_upserted':
      return {
        ...base,
        message: summarizeDisplayMessage(event.message, detailLevel, dataDir),
      };
    case 'message.pi_history_appended':
    case 'message.pi_history_replaced':
      return {
        ...base,
        messages: Array.isArray(event.messages)
          ? event.messages.map((message) => summarizePiMessage(message, detailLevel, dataDir))
          : [],
      };
    case 'message.turn_retracted':
      return {
        ...base,
        removedDisplayMessageCount: Array.isArray(event.removedDisplayMsgIds)
          ? event.removedDisplayMsgIds.length
          : 0,
        restoredPiMessageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      };
    case 'media.file_api_uploaded':
      return {
        ...base,
        ttlSec: finiteNumber(event.ttlSec, undefined),
        expiresAtMs: finiteNumber(event.expiresAtMs, undefined),
      };
    case 'session.snapshot_created':
      return { ...base, snapshotCreated: true };
    default:
      return base;
  }
}

function summarizeSessionRecord(record, detailLevel, dataDir) {
  if (!isRecord(record)) return undefined;
  return {
    agentName: stringOrUndefined(record.agentName),
    runtime: stringOrUndefined(record.runtime),
    sessionType: stringOrUndefined(record.sessionType),
    status: stringOrUndefined(record.status),
    archived: typeof record.archived === 'boolean' ? record.archived : undefined,
    createdAtMs: finiteNumber(record.createdAtMs, undefined),
    updatedAtMs: finiteNumber(record.updatedAtMs, undefined),
    ...(detailLevel === 'full'
      ? {
          titlePreview: previewText(record.title, dataDir),
          workspaceName: safeBasename(record.workspaceDir),
        }
      : {}),
  };
}

function summarizeDisplayMessage(message, detailLevel, dataDir) {
  if (!isRecord(message)) return { role: 'unknown', contentChars: 0, toolCallCount: 0, totalTokens: 0 };
  const content = typeof message.msg_content === 'string' ? message.msg_content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const usage = isRecord(message.usage) ? message.usage : {};
  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    messageType: typeof message.msg_type === 'string' || typeof message.msg_type === 'number'
      ? message.msg_type
      : undefined,
    messageKind: typeof message.kind === 'string' ? message.kind : undefined,
    contentChars: content.length,
    thinkingChars: typeof message.thinking_content === 'string' ? message.thinking_content.length : 0,
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
    toolCallCount: toolCalls.length,
    totalTokens: finiteNumber(usage.total_tokens, 0),
    ...(detailLevel === 'full'
      ? {
          contentPreview: previewText(content, dataDir),
          toolNames: unique(toolCalls.flatMap((call) =>
            isRecord(call) && typeof call.tool_name === 'string' ? [call.tool_name] : [],
          )),
        }
      : {}),
  };
}

function summarizePiMessage(message, detailLevel, dataDir) {
  if (!isRecord(message)) return { role: 'unknown', contentChars: 0, toolCallCount: 0, totalTokens: 0 };
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  const text = parts.flatMap((part) => {
    if (typeof part === 'string') return [part];
    return isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  }).join('\n');
  const toolNames = parts.flatMap((part) =>
    isRecord(part) && part.type === 'toolCall' && typeof part.name === 'string' ? [part.name] : [],
  );
  const usage = isRecord(message.usage) ? message.usage : {};
  return {
    role: typeof message.role === 'string' ? message.role : 'unknown',
    model: typeof message.model === 'string' ? message.model : undefined,
    stopReason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
    isError: typeof message.isError === 'boolean' ? message.isError : undefined,
    contentChars: text.length,
    imageCount: parts.filter((part) => isRecord(part) && part.type === 'image').length,
    toolCallCount: toolNames.length,
    totalTokens: finiteNumber(usage.totalTokens, 0),
    ...(detailLevel === 'full'
      ? {
          contentPreview: message.role === 'toolResult' ? undefined : previewText(text, dataDir),
          toolNames: unique([
            ...toolNames,
            ...(typeof message.toolName === 'string' ? [message.toolName] : []),
          ]),
          errorPreview:
            message.role === 'toolResult' ? undefined : previewText(message.errorMessage, dataDir),
        }
      : {}),
  };
}

export function previewText(value, dataDir = resolveDataDir()) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let redacted = value
    .replaceAll(path.resolve(dataDir), '<DATA_DIR>')
    .replaceAll(os.homedir(), '<HOME>')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1<REDACTED>')
    .replace(/\b(sk|gh[opsu]|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gu, '<REDACTED_SECRET>')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*([^\s,;]+)/giu, '$1=<REDACTED>');
  if (redacted.length > MAX_PREVIEW_CHARS) redacted = `${redacted.slice(0, MAX_PREVIEW_CHARS)}…`;
  return redacted;
}

async function* boundedJsonlLines(filePath, maxLineBytes) {
  let pending = EMPTY_BUFFER;
  let dropping = false;
  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (dropping) {
        if (newline !== -1) dropping = false;
      } else if (pending.length + segment.length > maxLineBytes) {
        pending = EMPTY_BUFFER;
        dropping = newline === -1;
        yield { kind: 'oversized' };
      } else {
        pending = pending.length === 0 ? Buffer.from(segment) : Buffer.concat([pending, segment]);
        if (newline !== -1) {
          yield { kind: 'line', text: stripCarriageReturn(pending.toString('utf8')), complete: true };
          pending = EMPTY_BUFFER;
        }
      }
      if (newline === -1) break;
      offset = newline + 1;
    }
  }
  if (!dropping && pending.length > 0) {
    yield { kind: 'line', text: stripCarriageReturn(pending.toString('utf8')), complete: false };
  }
}

async function isPlainDirectory(target) {
  try {
    const info = await lstat(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isPlainFile(target) {
  try {
    const info = await lstat(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function plainFileState(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return 'symlink';
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

async function assertPlainFile(target) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('symlink_artifact_rejected');
    if (!info.isFile()) throw new Error('ledger_not_regular_file');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('ledger_missing');
    throw error;
  }
}

function isLedgerEvent(value, sessionId) {
  return isRecord(value) && value.schemaVersion === 1 && value.sessionId === sessionId &&
    typeof value.eventId === 'string' && Number.isInteger(value.seq) &&
    typeof value.createdAtMs === 'number' && typeof value.kind === 'string';
}

function isInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function firstNonEmpty(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOrUndefined(value) {
  return typeof value === 'string' ? value : undefined;
}

function safeBasename(value) {
  return typeof value === 'string' && value ? path.basename(value) : undefined;
}

function stripCarriageReturn(value) {
  return value.endsWith('\r') ? value.slice(0, -1) : value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined))];
}

function sum(items, key) {
  return items.reduce((total, item) => total + finiteNumber(item?.[key], 0), 0);
}
