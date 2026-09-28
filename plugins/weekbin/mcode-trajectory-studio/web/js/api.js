/**
 * The one way this page talks to its own server: a same-origin JSON fetch that
 * carries the panel's capability, read from the URL fragment.
 *
 * A missing capability is reported as its own error rather than as a generic HTTP
 * failure, because the fix is a specific one — open the URL the agent returned,
 * including its `#t=…` fragment, instead of a hand-edited or truncated copy.
 */

import { panelToken } from './state.js';

export class UnauthorizedPanelError extends Error {
  constructor() {
    super('unauthorized_panel_url');
    this.name = 'UnauthorizedPanelError';
  }
}

/**
 * `signal` is optional so a caller can abandon a request it no longer wants — a
 * page of records for a session the reader has since left. Nothing here treats an
 * abort as a failure; whether a cancelled request counts as an error is the
 * caller's decision, because only the caller knows whether the view it fetched for
 * is still on screen.
 */
export async function api(pathname, { signal } = {}) {
  const token = panelToken();
  const response = await fetch(pathname, {
    headers: token ? { 'x-trajectory-token': token } : {},
    cache: 'no-store',
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 403 && payload.error === 'forbidden_token') throw new UnauthorizedPanelError();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}
