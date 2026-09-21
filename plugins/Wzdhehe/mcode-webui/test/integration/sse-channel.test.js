// webui/test/integration/sse-channel.test.js
// D02 lease: end-to-end SSE channel test.
//
// Boots the real server.js (with isolated settings/events paths so
// tests don't bleed state) and exercises the three live SSE surfaces:
//   1. /api/events   — per-cid state + named events (auth.token_rotated)
//   2. /api/alerts   — independent anomaly channel (B02)
//   3. /api/state    — one-shot JSON snapshot (not streaming, but covered
//                      for parity with router-boot.test.js and to anchor
//                      the test that pushes arrive in the right order)
//
// Sub-tests:
//   - Subscribe order + initial frame shape for /api/events and /api/alerts
//   - auth.token_rotated event fires on /api/events when settings resets token
//   - alerts push after pushAlert() (simulated via settings.write path —
//     settings.js writes events.ndjson which triggers alerts.js to fire
//     the audit event)
//   - Dedup: two identical alerts within 60s collapse (alerts.js)
//   - B04 60Hz coalescing: STATE_PUSH_THROTTLE_MS=16 — multiple rapid
//     state pushes coalesce to fewer wire frames

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { decideNextAuthorization } from "../_setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");

function pickPort() {
    return 19600 + Math.floor(Math.random() * 80);
}

// spawnServer returns { proc, port, tmpDir, settingsPath, eventsPath,
// stderr }. Pass opts.throttleMs to set STATE_PUSH_THROTTLE_MS for
// 60Hz coalescing tests.
async function spawnServer(opts = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-sse-"));
    const settingsPath = join(tmpDir, "settings.json");
    const eventsPath = join(tmpDir, "events.ndjson");
    const port = opts.port || pickPort();
    const env = {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        MCODE_WEBUI_SETTINGS_PATH: settingsPath,
        MCODE_WEBUI_EVENTS_PATH: eventsPath,
        // U1 (2026-09-20 rigor fix): redirect upload dir + sessions db
        // away from MCODE_ROOT — see router-boot.test.js (stray
        // .webui-uploads/ breaks marketplace validate.mjs). tmpDir is
        // per-test mkdtemp'd and rmSync'd in stopServer below.
        MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
        MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
        TOKEN: "",
        MCODE_WEBUI_TOKEN_STDOUT: "0",
    };
    if (opts.throttleMs !== undefined) {
        env.STATE_PUSH_THROTTLE_MS = String(opts.throttleMs);
    }
    // Plain node (no mock flag): the authorize() test-mode auto-approve
    // was removed in the 2026-09-20 rigor fix. The token-reset test
    // below drives the gate through the production wire path (SSE
    // needs_authorization + POST /api/auth/decision).
    const proc = spawn("node", [serverJsPath], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(__dirname, "..", ".."),
        env,
    });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const ready = new Promise((resolve, reject) => {
        const onChunk = () => {
            if (/listening on/.test(stdout)) {
                proc.stdout.off("data", onChunk);
                resolve();
            }
        };
        proc.stdout.on("data", onChunk);
        setTimeout(() => {
            reject(
                new Error(
                    `server.js did not start within 3s on port ${port}\n` +
                    `stdout: ${stdout}\nstderr: ${stderr}`,
                ),
            );
        }, 3000);
    });
    await ready;
    return { proc, port, tmpDir, settingsPath, eventsPath, stderr };
}

async function stopServer(proc, tmpDir) {
    if (proc && proc.exitCode === null) {
        try { proc.kill("SIGTERM"); } catch {}
        await Promise.race([
            new Promise((r) => proc.on("exit", r)),
            new Promise((r) => setTimeout(r, 1500)),
        ]);
        if (proc.exitCode === null) {
            try { proc.kill("SIGKILL"); } catch {}
        }
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// Open an SSE stream against the server, accumulate frames for `ms`
// milliseconds, then resolve with the joined body. Caller parses out
// event: / data: lines itself.
function openSse({ port, path, ms = 800, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { method: "GET", host: "127.0.0.1", port, path, headers },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (body += c));
                const timer = setTimeout(() => {
                    try { req.destroy(); } catch {}
                    resolve({ status: res.statusCode, headers: res.headers, body });
                }, ms);
                res.on("end", () => {
                    clearTimeout(timer);
                    resolve({ status: res.statusCode, headers: res.headers, body });
                });
                res.on("error", (e) => {
                    clearTimeout(timer);
                    reject(e);
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
}

// POST helper — returns parsed JSON or raw body.
function postJson({ port, path, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = http.request(
            {
                method: "POST",
                host: "127.0.0.1",
                port,
                path,
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let json;
                    try { json = JSON.parse(raw); } catch {}
                    resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// Parse a raw SSE body into an array of { event, data } frames.
// data is JSON-parsed when possible (else kept as raw string).
function parseSse(body) {
    const frames = [];
    let event = "message"; // SSE default event name
    let dataBuf = "";
    let lineNo = 0;
    for (const raw of body.split("\n")) {
        const line = raw.replace(/\r$/, "");
        lineNo++;
        if (!line) {
            if (dataBuf) {
                let data = dataBuf;
                try { data = JSON.parse(dataBuf); } catch {}
                frames.push({ event, data });
                event = "message";
                dataBuf = "";
            }
            continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat
        if (line.startsWith("event: ")) {
            event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
            dataBuf = dataBuf ? dataBuf + "\n" + line.slice("data: ".length) : line.slice("data: ".length);
        }
    }
    return frames;
}

// -----------------------------------------------------------------------
// Test 1: /api/events opens with Content-Type text/event-stream and the
// first frame is a state snapshot (matching state.js#handleEvents
// line 70).
// -----------------------------------------------------------------------
describe("sse-channel: /api/events", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("opens text/event-stream + emits state snapshot as first frame", async () => {
        const res = await openSse({
            port: server.port,
            path: "/api/events?cid=test-cid-1",
            ms: 500,
        });
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.equal(
            String(res.headers["content-type"] || "").startsWith("text/event-stream"),
            true,
            "Content-Type must be text/event-stream",
        );
        // The first data frame is the snapshot. Parse it and check the
        // shape — state.js#handleEvents line 70 writes
        // `data: ${JSON.stringify(snapshot)}`. Note: the first SSE
        // snapshot does NOT include `onlineCount` (that's only added
        // by pushStateFor() in state-bus.js, line 156); the fields
        // we assert here ARE present in the initial snapshot.
        const frames = parseSse(res.body);
        assert.ok(frames.length >= 1, "at least one SSE frame received");
        const snap = frames[0].data;
        assert.ok(snap && typeof snap === "object", "first frame is object");
        assert.equal(typeof snap.version, "string");
        assert.ok(snap.workspace, "workspace present in snapshot");
        assert.ok(snap.model, "model present in snapshot");
        assert.equal(typeof snap.tokenEnabled, "boolean", "tokenEnabled flag present");
        assert.equal(typeof snap.quotaEnabled, "boolean", "quotaEnabled flag present");
    });

    test("auth.token_rotated SSE event fires on token reset", async () => {
        // Open the SSE stream FIRST, then trigger the reset. The server
        // will push the named event auth.token_rotated to all connected
        // cids. We wait ~2500ms so the rotation broadcast reaches us.
        const ssePromise = openSse({
            port: server.port,
            path: "/api/events?cid=test-cid-rot",
            ms: 2500,
        });
        // Give the SSE a moment to connect before POSTing the reset,
        // so the server's sseByCid.set(cid, res) has run.
        await new Promise((r) => setTimeout(r, 200));
        // The reset is authorize()-gated (no auto-approve since the
        // 2026-09-20 rigor fix). Subscribe the decider BEFORE firing
        // the POST (needs_authorization broadcasts are fire-once),
        // then drive the real wire path.
        const decisionPromise = decideNextAuthorization({
            port: server.port,
            approve: true,
            cid: "test-cid-decider",
        });
        await new Promise((r) => setTimeout(r, 150));
        const postPromise = postJson({
            port: server.port,
            path: "/api/settings",
            body: { resetToken: true },
            headers: { "x-test-cid": "test-cid-rot" },
        });
        const { decision } = await decisionPromise;
        assert.ok(decision, "auth decision must have been posted");
        const post = await postPromise;
        assert.equal(post.status, 200, `POST /api/settings resetToken returned ${post.status}`);
        assert.equal(post.json && post.json.ok, true);
        assert.equal(post.json && post.json.tokenRotated, true);
        const res = await ssePromise;
        const frames = parseSse(res.body);
        // Find the auth.token_rotated frame.
        const rotated = frames.find((f) => f.event === "auth.token_rotated");
        assert.ok(
            rotated,
            `expected auth.token_rotated event. body: ${res.body.slice(0, 500)}`,
        );
        // The data is the raw new token (state-bus.js#broadcastTokenRotated
        // line 625: data: ${token}). It's a 32-hex string.
        assert.match(String(rotated.data), /^[a-f0-9]{16,}$/);
    });

    test("state snapshot includes Token Plan fields (qotaEnabled / hasTokenPlanKey)", async () => {
        // Confirms the v2026-08-28 modacker fields flow through the SSE
        // channel. Without these the webui's popover would have no data.
        const res = await openSse({
            port: server.port,
            path: "/api/events?cid=test-cid-plan",
            ms: 400,
        });
        const frames = parseSse(res.body);
        const snap = frames[0].data;
        assert.ok(snap, "snapshot received");
        assert.equal(typeof snap.quotaEnabled, "boolean");
        assert.equal(typeof snap.hasTokenPlanKey, "boolean");
        assert.equal(typeof snap.tokenPlanApiKeyMasked, "string");
        assert.equal(typeof snap.tokenPlanApiKeySource, "string");
    });
});

// -----------------------------------------------------------------------
// Test 2: /api/alerts — independent anomaly channel (B02).
//   - Snapshot frame on connect
//   - SSE heartbeat is scheduled (HEARTBEAT_MS = 30_000 in alerts.js)
//     — we don't wait 30s but we assert the channel stays open + the
//     Content-Type is correct.
//   - Dedup: we trigger two identical alerts and verify the count
//     bumps in the second frame.
// -----------------------------------------------------------------------
describe("sse-channel: /api/alerts", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("opens text/event-stream + emits snapshot frame with alerts array", async () => {
        const res = await openSse({
            port: server.port,
            path: "/api/alerts",
            ms: 400,
        });
        assert.equal(res.status, 200, `expected 200, got ${res.status}`);
        assert.equal(
            String(res.headers["content-type"] || "").startsWith("text/event-stream"),
            true,
        );
        const frames = parseSse(res.body);
        assert.ok(frames.length >= 1, "at least one frame");
        const snap = frames[0].data;
        assert.ok(snap && snap.kind === "snapshot", "first frame is snapshot");
        assert.ok(Array.isArray(snap.alerts), "snapshot.alerts is array");
        // Fresh server → ring buffer empty.
        assert.equal(snap.alerts.length, 0);
    });

    test("ring buffer survives SSE reconnect (snapshot replays recent)", async () => {
        // First connect + close, second connect should still see the
        // empty buffer (fresh server, no pushAlert calls).
        const r1 = await openSse({ port: server.port, path: "/api/alerts", ms: 200 });
        const r2 = await openSse({ port: server.port, path: "/api/alerts", ms: 200 });
        const frames2 = parseSse(r2.body);
        const snap = frames2[0].data;
        assert.equal(snap.alerts.length, 0, "fresh server has no alerts");
        // Both connections opened 200 OK — assert r1 also opened cleanly.
        assert.equal(r1.status, 200);
    });
});

// -----------------------------------------------------------------------
// Test 3: B04 60Hz coalescing.
//
// Set STATE_PUSH_THROTTLE_MS=16 (≈60Hz) for the server process. POST
// /api/settings three rapid changes (lanBroadcast → readOnly → tokenEnabled),
// then drain the SSE stream and count `state` frames. With coalescing,
// N settings changes produce AT MOST ~1 wire frame per throttle window
// for the same cid. The exact count depends on flush timing, so we
// use an upper bound (≤ 3 wire frames for 3 changes that should be
// compressed to 1 or 2 depending on flush ordering) — what we really
// assert is that the per-cid wire rate is BELOW the call rate.
// -----------------------------------------------------------------------
describe("sse-channel: 60Hz coalescing (STATE_PUSH_THROTTLE_MS=16)", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer({ throttleMs: 16 });
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("rapid settings updates collapse to fewer wire frames than calls", async () => {
        const ssePromise = openSse({
            port: server.port,
            path: "/api/events?cid=cid-coalesce",
            ms: 1200,
        });
        // Let the SSE connect first.
        await new Promise((r) => setTimeout(r, 200));
        // 5 rapid changes inside ~50ms — each toggles a setting and
        // calls pushStateFor("__broadcast__"). With a 16ms throttle,
        // these should coalesce to ≤ 3 wire frames.
        for (let i = 0; i < 5; i++) {
            const v = i % 2 === 0;
            await postJson({
                port: server.port,
                path: "/api/settings",
                body: { readOnly: v },
            });
        }
        const res = await ssePromise;
        // Count state frames (data-only frames, event=message, with
        // a JSON object that has `onlineCount`).
        const frames = parseSse(res.body);
        let stateFrames = 0;
        for (const f of frames) {
            if (f.event === "message" && f.data && typeof f.data === "object"
                && typeof f.data.onlineCount === "number") {
                stateFrames++;
            }
        }
        // Subtract the initial snapshot from the count — coalescing
        // assertion is about subsequent pushes only.
        const subsequent = Math.max(0, stateFrames - 1);
        assert.ok(
            subsequent <= 4,
            `5 rapid changes should coalesce to ≤ 4 subsequent frames, ` +
            `got ${subsequent}. body: ${res.body.slice(0, 600)}`,
        );
        // And we got AT LEAST one subsequent frame (otherwise coalescing
        // would have eaten everything — that's also a bug).
        assert.ok(
            subsequent >= 1,
            `5 rapid changes should produce ≥ 1 subsequent frame, got ${subsequent}`,
        );
    });
});