/**
 * A minimal synchronous event bus.
 *
 * Surfaces must not import each other's actions. A sidebar row that imports the
 * selection routine — which imports the sidebar again to re-render — is a module
 * cycle, and cycles make load order matter and refactors dangerous. Instead a
 * surface announces what the user did and forgets about it; the composition root
 * (`controller.js`) decides what that means.
 *
 * Leaf module — imports nothing, so any module may depend on it.
 */

const listeners = new Map();

/** Subscribe to a message type. Returns an unsubscribe function. */
export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);
  return () => { listeners.get(type)?.delete(handler); };
}

/** Publish a message to every current subscriber. Unknown types are a no-op. */
export function emit(type, payload) {
  const handlers = listeners.get(type);
  if (!handlers) return;
  for (const handler of [...handlers]) handler(payload);
}
