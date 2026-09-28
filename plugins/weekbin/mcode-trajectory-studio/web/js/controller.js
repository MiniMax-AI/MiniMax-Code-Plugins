/**
 * The composition root for intents.
 *
 * The one place that knows what an announced user action should actually do.
 * Subscribing here — instead of letting each surface import the action — is what
 * keeps the module graph acyclic: surfaces depend only on the intent leaf, while
 * the actions they would otherwise import depend on the surfaces to render. The
 * dependency now runs one way, from this controller down.
 */

import { on } from './bus.js';
import { SELECT_SESSION, LOCATE_ROW, LOCATE_TOOL_CALL, OPEN_INSPECTOR } from './intents.js';
import { selectSession, locateRow, locateToolCall } from './flow.js';
import { openInspector } from './inspector.js';
import { banner } from './banner.js';

/** Bind every intent to its action. Call once, before any surface can emit. */
export function installController() {
  // The bus is synchronous and cannot await, so a rejected selection would be an
  // unhandled rejection with nothing on screen to show for it. `selectSession`
  // rolls the selection back onto the session whose records are loaded before it
  // rethrows, so this notice is what tells the reader the click never took effect.
  on(SELECT_SESSION, ({ sessionId }) => {
    selectSession(sessionId).catch((error) => banner(`切换会话失败：${error.message}`));
  });
  on(LOCATE_ROW, ({ rowId }) => locateRow(rowId));
  on(LOCATE_TOOL_CALL, ({ toolCallId }) => locateToolCall(toolCallId));
  on(OPEN_INSPECTOR, (selection) => openInspector(selection));
}
