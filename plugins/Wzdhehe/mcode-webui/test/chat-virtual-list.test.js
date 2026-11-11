// webui/test/chat-virtual-list.test.js
// Unit tests for public/app/chat-virtual-list.js — pure-logic helpers
// for chat-list virtualization (Lease C04).
//
// Why this test exists: renderChat() in render.js delegates the
// scroll-window math to chat-virtual-list.js so the DOM-side code can
// stay small. The math itself (computeVirtualWindow / isNearBottom /
// decideScrollBehavior / estimateDomNodeCount) is testable without
// any DOM. These tests pin the contract: above the threshold N, the
// visible window is bounded around the user's scroll position, the
// threshold itself decides whether to engage virtualization, and the
// scroll-behavior decision distinguishes "actively watching" from
// "scrolled up to read history".
//
// Performance contract: for 10k messages the visible DOM stays under
// ~200 nodes (visible + buffer + 2 spacers). estimateDomNodeCount
// pins this bound.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    VIRTUAL_LIST_THRESHOLD,
    ESTIMATED_MESSAGE_HEIGHT,
    VIRTUAL_LIST_BUFFER,
    NEAR_BOTTOM_PX,
    computeVirtualWindow,
    isNearBottom,
    decideScrollBehavior,
    estimateDomNodeCount,
} from "../public/app/chat-virtual-list.js";

// ============================================================
// Constants: pinned exports — anything that changes here is a
// break-glass decision (visible DOM size, scroll precision, etc.)
// ============================================================
describe("constants — pinned by performance contract", () => {
    test("VIRTUAL_LIST_THRESHOLD = 200 (below this N, full render wins)", () => {
        assert.equal(VIRTUAL_LIST_THRESHOLD, 200);
    });
    test("ESTIMATED_MESSAGE_HEIGHT = 80 px (scrollbar precision vs cost)", () => {
        assert.equal(ESTIMATED_MESSAGE_HEIGHT, 80);
    });
    test("VIRTUAL_LIST_BUFFER = 50 messages (scroll headroom)", () => {
        assert.equal(VIRTUAL_LIST_BUFFER, 50);
    });
    test("NEAR_BOTTOM_PX = 50 px (auto-scroll trigger threshold)", () => {
        assert.equal(NEAR_BOTTOM_PX, 50);
    });
});

// ============================================================
// computeVirtualWindow: above threshold N, the visible window is
// bounded around scrollTop, and useVirtual=true. Below threshold N,
// full render.
// ============================================================
describe("computeVirtualWindow — virtual window math", () => {
    test("below threshold → useVirtual=false, render everything", () => {
        const out = computeVirtualWindow({
            totalCount: 199,
            scrollTop: 0,
            clientHeight: 600,
        });
        assert.equal(out.useVirtual, false);
        assert.equal(out.startIdx, 0);
        assert.equal(out.endIdx, 199);
        assert.equal(out.topSpacer, 0);
        assert.equal(out.bottomSpacer, 0);
    });

    test("at threshold (exactly 200) → useVirtual=true", () => {
        const out = computeVirtualWindow({
            totalCount: 200,
            scrollTop: 0,
            clientHeight: 600,
        });
        assert.equal(out.useVirtual, true,
            "N == threshold → virtual kicks in (>=, not >)");
    });

    test("at top of scroll, buffer extends below (clamped at 0 above)", () => {
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: 0,
            clientHeight: 600,
        });
        assert.equal(out.useVirtual, true);
        assert.equal(out.startIdx, 0,
            "buffer above clamped at 0 — no negative index");
        // visibleEnd = ceil(600/80) = 8, plus buffer 50 = 58
        assert.equal(out.endIdx, 58);
        assert.equal(out.topSpacer, 0);
        // bottomSpacer = (10000 - 58) * 80 = 9942 * 80 = 795_360
        assert.equal(out.bottomSpacer, (10_000 - 58) * 80);
    });

    test("in middle of scroll, buffer extends both ways", () => {
        // scrollTop = 80_000 → visibleStart = 1000, visibleEnd = ceil(80600/80) = 1008
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: 80_000,
            clientHeight: 600,
        });
        assert.equal(out.visibleStart, 1000);
        assert.equal(out.visibleEnd, 1008);
        // startIdx = 1000 - 50 = 950
        assert.equal(out.startIdx, 950);
        // endIdx = 1008 + 50 = 1058
        assert.equal(out.endIdx, 1058);
        assert.equal(out.topSpacer, 950 * 80);
        assert.equal(out.bottomSpacer, (10_000 - 1058) * 80);
    });

    test("near bottom, endIdx clamps at totalCount", () => {
        // scrollTop = 799_200 → visibleStart = 9990, visibleEnd = ceil(799800/80) = 9998
        // startIdx = 9940, endIdx = min(10000, 10048) = 10000
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: 799_200,
            clientHeight: 600,
        });
        assert.equal(out.startIdx, 9940);
        assert.equal(out.endIdx, 10_000,
            "endIdx clamped at totalCount when buffer extends past bottom");
        assert.equal(out.bottomSpacer, 0,
            "no bottom spacer when endIdx == totalCount");
    });

    test("scrollTop below 0 clamps at 0 (defensive)", () => {
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: -100,
            clientHeight: 600,
        });
        assert.equal(out.startIdx, 0);
        assert.equal(out.topSpacer, 0);
    });

    test("clientHeight 0 → empty visible window", () => {
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: 0,
            clientHeight: 0,
        });
        assert.equal(out.visibleStart, 0);
        assert.equal(out.visibleEnd, 0,
            "ceil(0/80)=0 — no visible messages but buffer still applies");
        // startIdx = max(0, 0 - 50) = 0; endIdx = min(10000, 0 + 50) = 50
        assert.equal(out.startIdx, 0);
        assert.equal(out.endIdx, 50);
    });

    test("totalCount 0 → empty window, useVirtual depends on threshold", () => {
        const out = computeVirtualWindow({
            totalCount: 0,
            scrollTop: 0,
            clientHeight: 600,
        });
        // totalCount 0 < threshold 200 → useVirtual=false
        assert.equal(out.useVirtual, false);
        assert.equal(out.startIdx, 0);
        assert.equal(out.endIdx, 0);
    });

    test("DOM count math: 10k messages → ~150 rendered", () => {
        const out = computeVirtualWindow({
            totalCount: 10_000,
            scrollTop: 400_000, // middle of chat
            clientHeight: 600,
        });
        const rendered = out.endIdx - out.startIdx;
        assert.ok(rendered < 200,
            `10k messages should render ≤200 nodes; got ${rendered}`);
        assert.ok(rendered >= VIRTUAL_LIST_BUFFER * 2,
            `rendered slice must include at least 2*buffer (top + bottom)`);
    });
});

// ============================================================
// isNearBottom: px threshold from the bottom; true means the user
// is "stuck" to the bottom (actively watching). Empty container
// returns true (no scroll position to preserve).
// ============================================================
describe("isNearBottom — px threshold detector", () => {
    test("exactly at bottom → true", () => {
        assert.equal(
            isNearBottom({ scrollTop: 1000, clientHeight: 200, scrollHeight: 1200 }),
            true,
        );
    });

    test("within 50 px of bottom → true (within threshold)", () => {
        // scrollTop + clientHeight = 1200 - 30 = 1170; scrollHeight - threshold = 1150
        // 1170 >= 1150 → true
        assert.equal(
            isNearBottom({ scrollTop: 970, clientHeight: 200, scrollHeight: 1200 }),
            true,
        );
    });

    test("more than 50 px from bottom → false (user scrolled up)", () => {
        // scrollTop + clientHeight = 1100; scrollHeight - threshold = 1150
        // 1100 < 1150 → false
        assert.equal(
            isNearBottom({ scrollTop: 900, clientHeight: 200, scrollHeight: 1200 }),
            false,
        );
    });

    test("empty container (scrollHeight 0) → true (no position to preserve)", () => {
        assert.equal(
            isNearBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 0 }),
            true,
        );
    });

    test("custom threshold (10 px) tightens the boundary", () => {
        // scrollTop + clientHeight = 1200 - 60 = 1140; scrollHeight - 10 = 1190
        // 1140 < 1190 → false at threshold=10
        assert.equal(
            isNearBottom({
                scrollTop: 940,
                clientHeight: 200,
                scrollHeight: 1200,
                threshold: 10,
            }),
            false,
        );
        // but at default 50 → 1140 >= 1150 → false (still false)
        // at threshold=200 → 1140 >= 1000 → true
        assert.equal(
            isNearBottom({
                scrollTop: 940,
                clientHeight: 200,
                scrollHeight: 1200,
                threshold: 200,
            }),
            true,
        );
    });
});

// ============================================================
// decideScrollBehavior: maps isNearBottom to 'auto' or 'preserve'.
// 'auto' = scroll to bottom on new message (typical case).
// 'preserve' = keep user position (they're reading history).
// ============================================================
describe("decideScrollBehavior — auto vs preserve", () => {
    test("at bottom → 'auto'", () => {
        assert.equal(
            decideScrollBehavior({
                scrollTop: 1000,
                clientHeight: 200,
                scrollHeight: 1200,
            }),
            "auto",
        );
    });

    test("scrolled up → 'preserve'", () => {
        assert.equal(
            decideScrollBehavior({
                scrollTop: 100,
                clientHeight: 200,
                scrollHeight: 1200,
            }),
            "preserve",
        );
    });

    test("empty container → 'auto' (nothing to preserve)", () => {
        assert.equal(
            decideScrollBehavior({
                scrollTop: 0,
                clientHeight: 200,
                scrollHeight: 0,
            }),
            "auto",
        );
    });
});

// ============================================================
// estimateDomNodeCount: quantifies the savings. With 10k messages
// the savings are ~98% — the cap on the per-render DOM cost.
// ============================================================
describe("estimateDomNodeCount — perf contract pin", () => {
    test("below threshold: no savings (full render)", () => {
        const out = estimateDomNodeCount({ totalCount: 100 });
        assert.equal(out.withVirtual, out.withoutVirtual);
        assert.equal(out.savings, 0);
    });

    test("10k messages: virtual keeps DOM ≤ 200", () => {
        const out = estimateDomNodeCount({ totalCount: 10_000 });
        assert.equal(out.withoutVirtual, 10_000);
        assert.ok(out.withVirtual <= 200,
            `10k messages should virtualize to ≤200 nodes; got ${out.withVirtual}`);
        assert.ok(out.savings > 9_800,
            `savings should be >98%; got ${out.savings} nodes saved`);
    });

    test("200 messages: just at threshold, savings kick in", () => {
        const out = estimateDomNodeCount({ totalCount: 200 });
        // totalCount >= threshold → useVirtual=true
        // visibleEnd = ceil(600/80) = 8, withVirtual = 8 + 100 + 2 = 110
        assert.ok(out.savings > 0,
            "at threshold N, virtualization saves nodes");
    });

    test("larger clientHeight = more visible rows, larger DOM", () => {
        const small = estimateDomNodeCount({ totalCount: 10_000, clientHeight: 600 });
        const large = estimateDomNodeCount({ totalCount: 10_000, clientHeight: 2000 });
        assert.ok(large.withVirtual > small.withVirtual,
            "taller viewport → more rows visible → more DOM nodes");
    });
});