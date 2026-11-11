// webui/public/app/chat-virtual-list.js
//
// Pure-logic helpers for the chat-list virtualization (Lease C04).
// No DOM dependencies, no app-state, no module-level globals —
// every function is a pure transform. This lets render.js wire the
// logic into the live chat, AND lets test/chat-virtual-list.test.js
// drive the math from Node without jsdom.
//
// Why virtual list?
//   For a chat with N=10k messages, the existing renderChat() calls
//   `inner.innerHTML = messages.map(...).join('')` — that's 10k DOM
//   nodes built per SSE state push (every chat delta / quota refresh /
//   token rotation triggers one). On a sustained 60Hz SSE stream, the
//   browser is rebuilding 10k DOM nodes per second. For 10k messages
//   the DOM count alone is ~30k nodes (each message has several child
//   elements: avatar / role badge / body / actions). Chromium handles
//   this but jank is visible.
//
//   The virtual list keeps the DOM bounded at ~50–150 nodes
//   (visible + buffer), regardless of N. Math happens here; the
//   actual DOM wiring lives in render.js.
//
// Architecture (one-sentence per piece):
//   - VIRTUAL_LIST_THRESHOLD: above this N, virtualization kicks in.
//     Below it we render everything — the per-message overhead is
//     small, and virtual list setup (spacers / scroll anchors) costs
//     more than it returns.
//   - ESTIMATED_MESSAGE_HEIGHT: average height we reserve per row when
//     computing the visible window. Real height varies by message type
//     (short user prompt vs long tool output) — we accept the
//     imprecision for the scrollbar model; the rendered DOM uses its
//     real height. The scrollbar is "approximate" but the user can
//     always scroll to reach any message.
//   - VIRTUAL_LIST_BUFFER: messages rendered above + below the
//     viewport. 50 gives ~5s of scroll headroom at typical mouse-wheel
//     rates before a re-render is needed.
//   - computeVirtualWindow(): the core math. Given (N, scrollTop,
//     clientHeight), returns {startIdx, endIdx, topSpacer, bottomSpacer,
//     useVirtual}. Render uses these to pick the slice + add spacer
//     divs.
//   - isNearBottom() / decideScrollBehavior(): when a new message
//     arrives (state.chat grows), the chat area should auto-scroll to
//     bottom IF the user was already near the bottom. If they had
//     scrolled up to read history, auto-scroll would yank them away
//     — preserve their position instead.
//
// Why fixed-height estimation instead of measured heights?
//   Measuring real heights would require rendering the entire list
//   off-screen first, then querying offsetTop. For 10k messages that
//   defeats the speedup. We accept ~20% scrollbar imprecision in
//   exchange for a fixed-O(1) compute cost per scroll tick.

// Below this N, skip virtualization entirely — render all messages.
// The threshold is the "knee" where full-render starts hurting the
// main thread. Empirically a chat under 200 messages renders in
// <16ms; over 200 the cost climbs fast.
export const VIRTUAL_LIST_THRESHOLD = 200;

// Average row height for scrollbar/spacer math. Real rows vary 40–300px
// depending on content. 80 covers most short messages; long messages
// overflow their slot and the scrollbar shifts a bit when the user
// scrolls over them, but the user can still navigate the full chat.
export const ESTIMATED_MESSAGE_HEIGHT = 80;

// Messages rendered above + below the viewport. 50 ≈ 5s of scroll
// headroom at 200 px/s mouse-wheel speed before the visible window
// has to be recomputed. Bigger buffer = smoother scrolling, more DOM.
export const VIRTUAL_LIST_BUFFER = 50;

// px threshold for "near bottom" detection. If the user is within
// this many px of the bottom, treat as "stuck to bottom" — auto-scroll
// on new messages. Above it, preserve the user's position.
export const NEAR_BOTTOM_PX = 50;

/**
 * Compute the visible message window given scroll metrics.
 *
 * @param {object} args
 * @param {number} args.totalCount - total messages in the chat
 * @param {number} args.scrollTop - chat-scroll.scrollTop (px from top)
 * @param {number} args.clientHeight - chat-scroll.clientHeight (viewport px)
 * @param {number} [args.rowHeight] - estimated row height (default 80)
 * @param {number} [args.buffer] - messages above/below viewport (default 50)
 * @param {number} [args.threshold] - N above which virtualization kicks in
 * @returns {{
 *   startIdx: number,
 *   endIdx: number,
 *   topSpacer: number,
 *   bottomSpacer: number,
 *   useVirtual: boolean,
 *   visibleStart: number,
 *   visibleEnd: number,
 * }}
 */
export function computeVirtualWindow({
    totalCount,
    scrollTop,
    clientHeight,
    rowHeight = ESTIMATED_MESSAGE_HEIGHT,
    buffer = VIRTUAL_LIST_BUFFER,
    threshold = VIRTUAL_LIST_THRESHOLD,
}) {
    if (totalCount < threshold) {
        return {
            startIdx: 0,
            endIdx: totalCount,
            topSpacer: 0,
            bottomSpacer: 0,
            useVirtual: false,
            visibleStart: 0,
            visibleEnd: totalCount,
        };
    }
    // Visible range (exclusive of buffer)
    const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight));
    const visibleEnd = Math.min(
        totalCount,
        Math.ceil((scrollTop + clientHeight) / rowHeight),
    );
    // Render range (inclusive of buffer)
    const startIdx = Math.max(0, visibleStart - buffer);
    const endIdx = Math.min(totalCount, visibleEnd + buffer);
    // Spacers push the rendered slice into the right scrollbar position
    const topSpacer = startIdx * rowHeight;
    const bottomSpacer = (totalCount - endIdx) * rowHeight;
    return {
        startIdx,
        endIdx,
        topSpacer,
        bottomSpacer,
        useVirtual: true,
        visibleStart,
        visibleEnd,
    };
}

/**
 * Is the user near the bottom of the chat scroll container?
 *
 * @param {object} args
 * @param {number} args.scrollTop
 * @param {number} args.clientHeight
 * @param {number} args.scrollHeight
 * @param {number} [args.threshold] - px threshold (default 50)
 * @returns {boolean}
 */
export function isNearBottom({
    scrollTop,
    clientHeight,
    scrollHeight,
    threshold = NEAR_BOTTOM_PX,
}) {
    if (scrollHeight <= 0) return true; // empty container → "at bottom"
    return scrollTop + clientHeight >= scrollHeight - threshold;
}

/**
 * Decide whether to auto-scroll on a new message or preserve user
 * position. Returns 'auto' when the user is near the bottom (typical
 * case for an actively-watching user), 'preserve' when they've scrolled
 * up to read history (auto-scroll would be jarring).
 *
 * @param {object} args
 * @param {number} args.scrollTop
 * @param {number} args.clientHeight
 * @param {number} args.scrollHeight
 * @param {number} [args.threshold]
 * @returns {'auto' | 'preserve'}
 */
export function decideScrollBehavior({
    scrollTop,
    clientHeight,
    scrollHeight,
    threshold = NEAR_BOTTOM_PX,
}) {
    return isNearBottom({ scrollTop, clientHeight, scrollHeight, threshold })
        ? "auto"
        : "preserve";
}

/**
 * DOM node count estimator. The current implementation always renders
 * N nodes (one per message). With virtualization, the DOM contains
 * approximately (endIdx - startIdx) message nodes + 2 spacer divs.
 * This helper lets render.js decide whether virtualization is worth
 * the setup cost for a given N.
 *
 * @param {object} args
 * @param {number} args.totalCount
 * @param {number} [args.rowHeight]
 * @param {number} [args.clientHeight]
 * @param {number} [args.buffer]
 * @param {number} [args.threshold]
 * @returns {{withoutVirtual: number, withVirtual: number, savings: number}}
 */
export function estimateDomNodeCount({
    totalCount,
    rowHeight = ESTIMATED_MESSAGE_HEIGHT,
    clientHeight = 600,
    buffer = VIRTUAL_LIST_BUFFER,
    threshold = VIRTUAL_LIST_THRESHOLD,
}) {
    const withoutVirtual = totalCount;
    if (totalCount < threshold) {
        return { withoutVirtual, withVirtual: withoutVirtual, savings: 0 };
    }
    const visibleEnd = Math.min(
        totalCount,
        Math.ceil(clientHeight / rowHeight),
    );
    const withVirtual = Math.min(totalCount, visibleEnd + buffer * 2) + 2; // +2 spacer divs
    return {
        withoutVirtual,
        withVirtual,
        savings: withoutVirtual - withVirtual,
    };
}