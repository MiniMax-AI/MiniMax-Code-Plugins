/**
 * The intents a surface may announce.
 *
 * An intent says what the user did — "they picked this session" — and nothing
 * about what should happen next. That is what lets a surface stay ignorant of the
 * loader it used to import, and what removes the module cycle: the dependency now
 * points at this leaf, not at the code that performs the action.
 */

import { emit } from './bus.js';

export const SELECT_SESSION = 'intent:select-session';
export const LOCATE_ROW = 'intent:locate-row';
export const LOCATE_TOOL_CALL = 'intent:locate-tool-call';
export const OPEN_INSPECTOR = 'intent:open-inspector';

export const selectSession = (sessionId) => emit(SELECT_SESSION, { sessionId });
export const locateRow = (rowId) => emit(LOCATE_ROW, { rowId });
export const locateToolCall = (toolCallId) => emit(LOCATE_TOOL_CALL, { toolCallId });
export const openInspector = (selection) => emit(OPEN_INSPECTOR, selection);
