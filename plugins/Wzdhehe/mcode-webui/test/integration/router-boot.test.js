// webui/test/integration/router-boot.test.js
// D02 lease: end-to-end router boot test.
//
// Spawn the real server.js on a random high port (avoids collision with
// any real webui / dev server on 8080). Talk to it with node:http and
// hit each documented route from server/router.js. Each route has at
// least one happy path + one error path. The mcode subprocess is NOT
// exercised here — the routes we hit (health / state / alerts /
// forecast / export / static) do not invoke mcode, and we don't want
// the test to depend on the host having mcode installed.
//
// Why not mock everything in-process: the value of an integration test
// is to validate the REAL server.js bootstrap path (import graph +
// initSettings + listen + router dispatch + 5 gates). Mocking the
// router import would skip gate ordering, CORS preflight, etc.
//
// Scope (D02 brief):
//   GET  /api/health              (happy + 404 path)
//   GET  /api/state               (happy + wrong method)
//   GET  /api/alerts              (SSE happy; bad path = wrong method)
//   GET  /api/usage/forecast      (happy + zero-history reason)
//   GET  /api/sessions/<id>/export (happy md + error 404)
//   GET  /                        (happy static index)
//   GET  /api/nonsense            (404 path)

import { test } from "node:test";
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

// Port-pick: 19500..19600 — outside the dev range (8080), outside the
// C08 helper range (18080/18081), outside privileged (<1024). Even on
// busy machines this range is usually free; if it isn't, the test
// fails loudly with EADDRINUSE which is the right signal.
function pickPort() {
    return 19500 + Math.floor(Math.random() * 100);
}

// Spawn server.js with isolated settings + events paths. Returns
// { proc, port, tmpDir, ready }. `ready` resolves once the server
// prints "listening on" (or rejects after 3s with the captured stderr).
async function spawnServer() {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-router-"));
    const settingsPath = join(tmpDir, "settings.json");
    const eventsPath = join(tmpDir, "events.ndjson");
    const port = pickPort();
    const env = {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1", // loopback only — auth gates still bypass for local
        MCODE_WEBUI_SETTINGS_PATH: settingsPath,
        MCODE_WEBUI_EVENTS_PATH: eventsPath,
        // U1 (2026-09-20 rigor fix): redirect upload dir + sessions db
        // away from MCODE_ROOT — server.js mkdirSync(UPLOAD_DIR) at boot
        // and persistCurrentChat's saveSessions would otherwise create
        // stray .webui-uploads/ + .webui-sessions.json in the plugin
        // tree, which breaks marketplace validate.mjs ("invalid Plugin
        // directory"). tmpDir is per-test mkdtemp'd and rmSync'd in
        // stopServer below, so cleanup stays automatic.
        MCODE_WEBUI_UPLOAD_DIR: join(tmpDir, "uploads"),
        MCODE_WEBUI_SESSIONS_DB: join(tmpDir, "sessions.json"),
        TOKEN: "", // explicit empty so auth init is deterministic
        // Disable TOKEN_STDOUT so stdout is clean for assertion.
        MCODE_WEBUI_TOKEN_STDOUT: "0",
    };
    // Plain node (no mock flag): the authorize() test-mode auto-approve
    // was removed in the 2026-09-20 rigor fix. Gated routes (export)
    // are decided through the production wire path — the test
    // subscribes the decider SSE, captures needs_authorization, and
    // POSTs /api/auth/decision (see the export tests below).
    const proc = spawn("node", [serverJsPath], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: join(__dirname, "..", ".."),
        env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    const ready = new Promise((resolve, reject) => {
        const onChunk = (chunk) => {
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
        // Wait for clean exit, but don't hang the test suite.
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

// Tiny node:http client. Returns { status, headers, body, json? }.
//   - body is a string (raw); json is set when Content-Type is JSON
//     AND JSON.parse succeeds (else json stays undefined).
//   - response body is fully buffered before resolve.
//   - U4 (2026-09-20): settlement guarantee — the waiting side must have a
//     timeout bail-out and must NOT rely on the server (or incidental
//     event-loop handles) keeping the test alive. Before this, a server-side
//     hang (acp.mjs pending never settling when mcode is absent on Linux)
//     turned into a permanent 60s suite hang instead of a fast failure.
function httpRequest({ method = "GET", host = "127.0.0.1", port, path, headers = {}, timeoutMs = 10000 }) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            req.destroy();
            reject(new Error(
                `httpRequest: no response within ${timeoutMs}ms for ${method} ${path}`,
            ));
        }, timeoutMs);
        const req = http.request(
            { method, host, port, path, headers: { Connection: "close", ...headers } },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    clearTimeout(timer);
                    const body = Buffer.concat(chunks).toString("utf8");
                    let json;
                    const ct = String(res.headers["content-type"] || "");
                    if (ct.includes("application/json")) {
                        try { json = JSON.parse(body); } catch { /* keep undefined */ }
                    }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body,
                        json,
                    });
                });
                res.on("error", (e) => {
                    clearTimeout(timer);
                    reject(e);
                });
            },
        );
        req.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        req.end();
    });
}

// -----------------------------------------------------------------------
// Test fixture: one server per test. beforeEach spawns, afterEach stops.
// Keeps state isolation across tests (settings.json, events.ndjson).
// -----------------------------------------------------------------------

let server;
test.beforeEach(async () => {
    server = await spawnServer();
});
test.afterEach(async () => {
    if (server) await stopServer(server.proc, server.tmpDir);
    server = null;
});

// -----------------------------------------------------------------------
// /api/health — happy + 404 (a wrong-method GET on a POST-only route is
// documented as the "404" path here; router.js line 432 returns 404
// when no route matches).
// -----------------------------------------------------------------------
test("router-boot: GET /api/health returns service info", async () => {
    const res = await httpRequest({ port: server.port, path: "/api/health" });
    assert.equal(res.status, 200, `expected 200, got ${res.status}. body: ${res.body}`);
    assert.ok(res.json, "response must be JSON");
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.port, "number");
    assert.equal(typeof res.json.defaultModel, "string");
    assert.equal(typeof res.json.defaultWorkspace, "string");
});

test("router-boot: unknown route returns 404 from router tail", async () => {
    const res = await httpRequest({ port: server.port, path: "/api/this-does-not-exist" });
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
});

// -----------------------------------------------------------------------
// /api/state — happy + wrong-method (POST /api/state isn't registered,
// falls through to 404 because no route matches the method+path pair).
// -----------------------------------------------------------------------
test("router-boot: GET /api/state returns client state snapshot", async () => {
    const res = await httpRequest({ port: server.port, path: "/api/state" });
    assert.equal(res.status, 200, `expected 200, got ${res.status}. body: ${res.body}`);
    assert.ok(res.json, "response must be JSON");
    // Snapshot fields confirmed in server/routes/state.js#handleState
    // (lines 117-156). Note: `onlineCount` is only on the SSE push
    // (state-bus.js line 156), not the /api/state JSON response.
    assert.equal(typeof res.json.version, "string", "version field present");
    assert.ok(res.json.workspace, "workspace field present");
    assert.ok(res.json.model, "model field present");
    assert.equal(Array.isArray(res.json.chat), true, "chat is an array");
    assert.equal(typeof res.json.readOnly, "boolean", "readOnly flag present");
    assert.equal(typeof res.json.tokenEnabled, "boolean", "tokenEnabled flag present");
    assert.equal(typeof res.json.quotaEnabled, "boolean", "quotaEnabled flag present");
});

test("router-boot: POST /api/state returns 404 (route is GET-only)", async () => {
    const res = await httpRequest({
        method: "POST",
        port: server.port,
        path: "/api/state",
    });
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
});

// -----------------------------------------------------------------------
// /api/alerts — SSE. We just hit it once and read the first frame
// (snapshot). For full streaming tests, see sse-channel.test.js. The
// "error path" here is the wrong-method attempt.
// -----------------------------------------------------------------------
test("router-boot: GET /api/alerts opens SSE + emits snapshot frame", async () => {
    const res = await new Promise((resolve, reject) => {
        const req = http.request(
            { method: "GET", host: "127.0.0.1", port: server.port, path: "/api/alerts" },
            (r) => {
                const chunks = [];
                r.on("data", (c) => chunks.push(c));
                const timer = setTimeout(() => {
                    req.destroy();
                    resolve({
                        status: r.statusCode,
                        headers: r.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                }, 200);
                r.on("end", () => {
                    clearTimeout(timer);
                    resolve({
                        status: r.statusCode,
                        headers: r.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
                r.on("error", (e) => {
                    clearTimeout(timer);
                    reject(e);
                });
            },
        );
        req.on("error", reject);
        req.end();
    });
    assert.equal(res.status, 200, `expected 200 SSE, got ${res.status}`);
    assert.equal(
        String(res.headers["content-type"] || "").startsWith("text/event-stream"),
        true,
        "Content-Type must be text/event-stream",
    );
    // Snapshot frame: data: {"kind":"snapshot","alerts":[]}
    assert.match(res.body, /data: \{[^]*"kind":\s*"snapshot"/);
    assert.match(res.body, /"alerts":\s*\[\]/);
});

test("router-boot: POST /api/alerts returns 404 (SSE route is GET-only)", async () => {
    const res = await httpRequest({
        method: "POST",
        port: server.port,
        path: "/api/alerts",
    });
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
});

// -----------------------------------------------------------------------
// /api/usage/forecast — happy + error path is "no history" (reason:
// "no_history"). The route is GET-only — POST would 404.
// -----------------------------------------------------------------------
test("router-boot: GET /api/usage/forecast returns no_history on fresh server", async () => {
    const res = await httpRequest({ port: server.port, path: "/api/usage/forecast" });
    assert.equal(res.status, 200, `expected 200, got ${res.status}. body: ${res.body}`);
    assert.ok(res.json, "response must be JSON");
    assert.equal(res.json.ok, true);
    assert.ok(res.json.forecast, "forecast field present");
    // Fresh server → no history → quota-forecast.js returns reason "no_history"
    // (forecastExhaustion: empty history branch, line 240-249).
    assert.equal(res.json.forecast.reason, "no_history");
    assert.equal(res.json.forecast.samples, 0);
    assert.equal(res.json.forecast.hoursUntilExhaustion5h, null);
    assert.equal(res.json.forecast.model, "least-squares-linear");
});

test("router-boot: POST /api/usage/forecast returns 404 (route is GET-only)", async () => {
    const res = await httpRequest({
        method: "POST",
        port: server.port,
        path: "/api/usage/forecast",
    });
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
});

// -----------------------------------------------------------------------
// /api/sessions/<id>/export — happy md path + error 404 (unknown id).
// The authorize gate is live (auto-approve removed in the 2026-09-20
// rigor fix); the gated requests below drive the real decision wire
// path via decideNextAuthorization.
// -----------------------------------------------------------------------
test("router-boot: GET /api/sessions/<id>/export?format=json returns 404 for unknown id", async () => {
    // Subscribe the decider BEFORE firing the gated request
    // (needs_authorization broadcasts are fire-once).
    const decisionPromise = decideNextAuthorization({
        port: server.port,
        approve: true,
        cid: "cid-router-boot",
    });
    await new Promise((r) => setTimeout(r, 150));
    const resPromise = httpRequest({
        port: server.port,
        path: "/api/sessions/nonexistent-session-id-xyz/export?format=json",
    });
    const { decision } = await decisionPromise;
    assert.ok(decision, "auth decision must have been posted");
    const res = await resPromise;
    // 404 path: session lookup fails (export.js line 392-394).
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
    assert.ok(res.json, "error response is JSON");
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, "session not found");
});

test("router-boot: GET /api/sessions//export?format=bad returns 400 unsupported format", async () => {
    // Use a syntactically valid id but unsupported format — easier than
    // creating a real session, and the format check happens BEFORE the
    // session lookup (export.js line 357-361).
    const res = await httpRequest({
        port: server.port,
        path: "/api/sessions/anything/export?format=xml",
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}. body: ${res.body}`);
    assert.ok(res.json, "error response is JSON");
    assert.equal(res.json.error, "unsupported format");
    assert.deepEqual(res.json.allowed, ["md", "json"]);
});

// -----------------------------------------------------------------------
// Static SPA: GET / serves the index.html. This exercises serveIndex
// in static.js. The 404 path is requesting a non-existent static asset
// after the dot-routing step (router.js line 405-408).
// -----------------------------------------------------------------------
test("router-boot: GET / serves index.html or 404 fallback", async () => {
    const res = await httpRequest({ port: server.port, path: "/" });
    // The plugin's public/index.html may or may not exist depending on
    // the install layout. We accept either:
    //   - 200 with HTML body (index.html present), OR
    //   - 404 with the router's "not found" tail (index.html absent —
    //     serveIndex returns false → router hits the fallback path).
    assert.ok(
        res.status === 200 || res.status === 404,
        `expected 200 or 404, got ${res.status}. body: ${res.body.slice(0, 200)}`,
    );
});

test("router-boot: GET /api/state.missing returns 404 (no static + no api route)", async () => {
    // Path with a dot triggers the static-file branch (router.js line 405-408).
    // If serveStatic returns false, the loop falls through to the 404 tail.
    const res = await httpRequest({ port: server.port, path: "/api/state.missing" });
    assert.equal(res.status, 404, `expected 404, got ${res.status}. body: ${res.body}`);
});

// -----------------------------------------------------------------------
// OPTIONS preflight — exercises the CORS gate (router.js OPTIONS
// short-circuit). v2 trusted-origin policy (PR #55 review point 1):
// no Origin (curl-shaped) → 204 with NO CORS headers; trusted Origin →
// 204 with the origin reflected; untrusted Origin → 204 with NO CORS
// headers (preflight consistent with the actual response, so the
// browser blocks the follow-up request).
// -----------------------------------------------------------------------
test("router-boot: OPTIONS without Origin returns 204 and no CORS headers (non-browser clients)", async () => {
    const res = await httpRequest({
        method: "OPTIONS",
        port: server.port,
        path: "/api/state",
    });
    assert.equal(res.status, 204, `expected 204, got ${res.status}`);
    assert.equal(
        res.headers["access-control-allow-origin"],
        undefined,
        "no Origin header → no Access-Control-Allow-Origin (CORS headers are meaningless for non-browser clients)",
    );
});

test("router-boot: OPTIONS with the server's own Origin returns 204 + reflected ACAO", async () => {
    const res = await httpRequest({
        method: "OPTIONS",
        port: server.port,
        path: "/api/state",
        headers: { Origin: `http://127.0.0.1:${server.port}` },
    });
    assert.equal(res.status, 204, `expected 204, got ${res.status}`);
    assert.equal(
        String(res.headers["access-control-allow-origin"] || ""),
        `http://127.0.0.1:${server.port}`,
        "trusted origin must be reflected verbatim, never a wildcard",
    );
});

test("router-boot: OPTIONS with an untrusted Origin returns 204 and NO CORS headers", async () => {
    const res = await httpRequest({
        method: "OPTIONS",
        port: server.port,
        path: "/api/state",
        headers: { Origin: "http://evil.example" },
    });
    assert.equal(res.status, 204, `expected 204, got ${res.status}`);
    assert.equal(
        res.headers["access-control-allow-origin"],
        undefined,
        "untrusted origin must get zero Access-Control-* headers on preflight (consistent with actual responses)",
    );
});

// -----------------------------------------------------------------------
// CORS headers on a regular response — v2: Origin-less requests carry
// no CORS headers (gate 1 only reflects for a present, trusted Origin).
// -----------------------------------------------------------------------
test("router-boot: response without Origin carries no CORS headers (gate 1)", async () => {
    const res = await httpRequest({ port: server.port, path: "/api/health" });
    assert.equal(res.status, 200);
    assert.equal(
        res.headers["access-control-allow-origin"],
        undefined,
        "no Origin header → no Access-Control-Allow-Origin on the actual response",
    );
});

test("router-boot: GET with trusted Origin gets the origin reflected (readable)", async () => {
    const res = await httpRequest({
        port: server.port,
        path: "/api/health",
        headers: { Origin: `http://localhost:${server.port}` },
    });
    assert.equal(res.status, 200);
    assert.equal(
        String(res.headers["access-control-allow-origin"] || ""),
        `http://localhost:${server.port}`,
        "own serving origin is trusted and reflected verbatim",
    );
});

test("router-boot: GET with untrusted Origin gets NO CORS headers (body unreadable by the page)", async () => {
    const res = await httpRequest({
        port: server.port,
        path: "/api/health",
        headers: { Origin: "http://evil.example" },
    });
    assert.equal(res.status, 200, "the GET itself still executes — only the read is denied");
    assert.equal(
        res.headers["access-control-allow-origin"],
        undefined,
        "untrusted origin must not be able to read the response body",
    );
});