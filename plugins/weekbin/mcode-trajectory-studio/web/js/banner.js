/**
 * The transient notice bar.
 *
 * One fixed element re-used for every message, auto-hiding after a few seconds so
 * a stale notice cannot be mistaken for current state.
 */

const HIDE_AFTER_MS = 6000;
let hideTimer = null;

export function banner(message) {
  const node = document.getElementById('banner');
  if (!node) return;
  node.textContent = String(message);
  node.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { node.hidden = true; }, HIDE_AFTER_MS);
}
