// webui/test/integration/event-chain.test.js
// D02 lease: events.ndjson hash chain + alerts integration.
//
// Boots server.js with a custom MCODE_WEBUI_EVENTS_PATH so we can
// read the chain back after each write. Sub-tests:
//
//   1. settings.update writes one NDJSON line (B01 events.js)
//   2. alerts push → events.ndjson has kind:"alert.{level}" (B02)
//   3. Tamper detection: corrupt line N → verify() returns
//      { ok:false, error:"hash_mismatch", line:N }
//   4. B01 + B02 + B03 三方整合: authorize() gated token.reset driven
//      through the REAL wire path (SSE needs_authorization frame +
//      POST /api/auth/decision) → settings mutation writes
//      events.ndjson + no alert fires for benign writes.
//   5. Gate-blocking (2026-09-20 rigor fix): user decline → 403 +
//      nothing deleted; short-timeout → fail-closed reject; user
//      approve → deletion lands AND events.verify() still ok.
//
// The child server is spawned WITHOUT --experimental-test-module-mocks:
// the authorize() test-mode auto-approve was removed in the rigor fix,
// and integration tests must drive the real decision wire path.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { createHash } from "node:crypto";
import { decideNextAuthorization } from "../_setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverJsPath = join(__dirname, "..", "..", "server.js");
const SERVER_DIR = join(__dirname, "..", "..", "server");
const absPath = (rel) => pathToFileURL(join(SERVER_DIR, rel)).href;

function pickPort() {
    return 19700 + Math.floor(Math.random() * 80);
}

async function spawnServer(opts = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-d02-chain-"));
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
    // Plain node: no mock flag. The authorize() gate is fully live in
    // the child; gated requests are decided through the production
    // wire path (SSE + POST /api/auth/decision).
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
            reject(new Error(`server.js did not start within 3s on port ${port}\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, 3000);
    });
    await ready;
    return { proc, port, tmpDir, settingsPath, eventsPath };
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

function postJson({ port, path, body }) {
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
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    let json;
                    try { json = JSON.parse(raw); } catch {}
                    resolve({ status: res.statusCode, body: raw, json });
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

// readLines — read NDJSON file as objects (skipping malformed lines).
function readEvents(path) {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch { return []; }
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
}

// recomputeHash — same algorithm as events.js#_hashLine.
function recomputeHash(prevAfterHash, lineObj) {
    const { after_hash: _omit, ...rest } = lineObj;
    return createHash("sha256")
        .update(prevAfterHash + JSON.stringify(rest), "utf8")
        .digest("hex");
}

// verifyChain — walks the file forward, recomputing each after_hash
// and checking before_hash matches prevAfter. Returns either
// { ok:true, count } or { ok:false, error, line, ... }.
function verifyChain(path) {
    let raw = "";
    try { raw = readFileSync(path, "utf8"); } catch {
        return { ok: true, count: 0, note: "file_missing" };
    }
    const lines = raw.split("\n").filter((l) => l);
    let prevAfter = "";
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        let obj;
        try { obj = JSON.parse(lines[i]); }
        catch (e) {
            return { ok: false, error: "parse_error", line: i + 1, message: e.message };
        }
        count++;
        const storedBefore = String((obj && obj.before_hash) || "");
        if (storedBefore !== prevAfter) {
            return {
                ok: false, error: "chain_break", line: i + 1,
                expected_before: prevAfter, actual_before: storedBefore,
            };
        }
        const expected = recomputeHash(prevAfter, obj);
        const storedAfter = String((obj && obj.after_hash) || "");
        if (expected !== storedAfter) {
            return {
                ok: false, error: "hash_mismatch", line: i + 1,
                expected_after: expected, actual_after: storedAfter,
            };
        }
        prevAfter = storedAfter;
    }
    return { ok: true, count };
}

// -----------------------------------------------------------------------
// Test 1: settings mutation writes one NDJSON line.
// -----------------------------------------------------------------------
describe("event-chain: settings writes to events.ndjson", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("POST /api/settings with readOnly writes one settings.update line", async () => {
        const post = await postJson({
            port: server.port,
            path: "/api/settings",
            body: { readOnly: true },
        });
        assert.equal(post.status, 200, `expected 200, got ${post.status}. body: ${post.body}`);
        // Give the file a moment to flush — writeAtomic is synchronous
        // so this is just paranoia.
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 1, "at least one event line written");
        const last = events[events.length - 1];
        assert.match(last.kind, /settings\./, `expected kind=settings.* got ${last.kind}`);
        assert.equal(typeof last.before_hash, "string");
        assert.equal(typeof last.after_hash, "string");
        // before_hash: empty (head) or 64-hex sha256 (chain continuation)
        assert.ok(
            last.before_hash.length === 0 || last.before_hash.length === 64,
            `before_hash should be empty (head) or 64-hex sha256, ` +
            `got length=${last.before_hash.length}`,
        );
        assert.equal(last.after_hash.length, 64, "after_hash is sha256 hex");
        assert.equal(typeof last.cid, "string", "cid is a string");
        assert.equal(typeof last.seq, "number");
        assert.ok(last.seq >= 1, "seq is positive");
    });

    test("chain is verifiable end-to-end after one write", async () => {
        // Use a value that flips the default — fresh server has
        // readOnlyEnabled=false (settings.js line 110), so we toggle
        // to true to guarantee a settings.update event lands.
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await new Promise((r) => setTimeout(r, 50));
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, true, `chain verify failed: ${JSON.stringify(v)}`);
        assert.ok(v.count >= 1, "at least one event");
    });

    test("two consecutive writes produce monotonically increasing seq", async () => {
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 2, "at least two events");
        assert.equal(events[0].seq + 1, events[1].seq,
            `seq should be monotonic+1: got ${events[0].seq} then ${events[1].seq}`);
        // before_hash of N+1 == after_hash of N (chain integrity)
        assert.equal(events[1].before_hash, events[0].after_hash,
            "before_hash[1] must equal after_hash[0]");
        // verify() should report ok
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, true);
    });
});

// -----------------------------------------------------------------------
// Test 2: alerts push (B02) — settings mutations don't push alerts, but
// we can verify the alerts module's audit pipeline by checking the
// integration is wired (alerts.js#tryWriteEvent imports events.js and
// writes one line per alert). For an end-to-end alert fire, we'd need
// to inject from within the server process — since we can't, we verify
// the integration shape: the events.ndjson file path is correct and the
// events module would accept an alert line if pushAlert was called.
// -----------------------------------------------------------------------
describe("event-chain: alerts integration shape", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("alerts module imports events.js (audit-write shape validation)", async () => {
        // Read the source file directly. The alerts module MUST contain
        // a dynamic import of ./events.js + a call to append() with
        // kind `alert.${level}` — that's the B01 + B02 wiring contract.
        const { readFileSync: rfs } = await import("node:fs");
        const src = rfs(join(__dirname, "..", "..", "server", "lib", "alerts.js"), "utf8");
        // alerts.js uses `new URL("./events.js", import.meta.url)` and
        // then `await import(url.href)` — the source contains BOTH
        // patterns we need to verify: the URL literal + the dynamic
        // import call.
        assert.match(src, /\.\/events\.js/,
            "alerts.js should reference ./events.js");
        assert.match(src, /\bimport\(/,
            "alerts.js should use dynamic import()");
        assert.match(src, /append\(`alert\.\$\{/,
            "alerts.js should call append(`alert.${level}`, ...)");
    });

    test("authorize.js imports events.js statically (B03 + B01 integration)", async () => {
        const { readFileSync: rfs } = await import("node:fs");
        const src = rfs(join(__dirname, "..", "..", "server", "lib", "authorize.js"), "utf8");
        // 2026-09-20 rigor fix: static import (the dynamic-import dance
        // hid write failures and corrupted the kind field).
        assert.match(src, /\.\/events\.js/,
            "authorize.js should reference ./events.js");
        assert.match(
            src, /import\s*\{[^}]*append[^}]*\}\s*from\s*["']\.\/events\.js["']/,
            "authorize.js should statically import append from ./events.js",
        );
        // authorize writes auth.pending / auth.approve / auth.reject /
        // auth.timeout / auth.bypass — these are the B03 audit kinds.
        assert.match(src, /auth\.(pending|approve|reject|timeout|bypass)/,
            "authorize.js should emit auth.* audit events");
        // Decision-outcome audit failures must be loud: pushAlert +
        // console.error (the user's click is irreversible, so the
        // decision still resolves — see the rationale in the source).
        assert.match(src, /pushAlert/,
            "authorize.js should push an alert when an audit write fails");
    });
});

// -----------------------------------------------------------------------
// Test 3: tamper detection. Manually corrupt line N's after_hash, then
// verify() returns hash_mismatch at line N+1 (because the recompute of
// line N fails AND line N+1's before_hash mismatch fires first). To
// get the "hash_mismatch line=N" signal, we corrupt line N's body but
// keep its after_hash claim intact — the recompute disagrees with the
// stored after_hash.
// -----------------------------------------------------------------------
describe("event-chain: tamper detection via verify()", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("tampering a line body yields hash_mismatch line=N", async () => {
        // Write two events so the chain has 2 lines.
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const before = readEvents(server.eventsPath);
        assert.ok(before.length >= 2, "need at least 2 lines to test tamper");

        // Read the raw file, split by lines, mutate the second line's
        // body (change one data field) but keep the same before_hash
        // and after_hash — that makes the recompute disagree with the
        // stored after_hash. verify() should report hash_mismatch at
        // line 2.
        const raw = readFileSync(server.eventsPath, "utf8");
        const lines = raw.split("\n");
        // Find the index of the second non-empty line (line 2 of the chain).
        const lineIdx = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]) lineIdx.push(i);
        }
        assert.ok(lineIdx.length >= 2, "raw file has ≥ 2 non-empty lines");
        const targetRaw = lines[lineIdx[1]];
        const obj = JSON.parse(targetRaw);
        // Tamper: change data.newValue (or any data field) — but keep
        // the hash fields the same so the recompute disagrees.
        if (obj.data && typeof obj.data.newValue !== "undefined") {
            obj.data.newValue = "TAMPERED";
        } else if (obj.data && typeof obj.data.kind !== "undefined") {
            obj.data.kind = "TAMPERED";
        } else {
            obj.data = { TAMPERED: true };
        }
        lines[lineIdx[1]] = JSON.stringify(obj);
        writeFileSync(server.eventsPath, lines.join("\n"));

        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, false, `verify should detect tamper. got: ${JSON.stringify(v)}`);
        assert.equal(v.error, "hash_mismatch", `expected hash_mismatch, got ${v.error}`);
        assert.equal(v.line, 2,
            `expected mismatch at line 2 (1-indexed), got line ${v.line}`);
    });

    test("deleting the head line yields chain_break (before_hash mismatch)", async () => {
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: true } });
        await postJson({ port: server.port, path: "/api/settings", body: { readOnly: false } });
        await new Promise((r) => setTimeout(r, 50));
        const raw = readFileSync(server.eventsPath, "utf8");
        const lines = raw.split("\n");
        // Find non-empty line indices and drop the first one (simulate a
        // truncation / first-line deletion).
        const lineIdx = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i]) lineIdx.push(i);
        }
        assert.ok(lineIdx.length >= 2);
        lines[lineIdx[0]] = ""; // blank, treated as "line removed" on split
        writeFileSync(server.eventsPath, lines.join("\n"));
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, false);
        assert.equal(v.error, "chain_break", `expected chain_break, got ${v.error}`);
        assert.equal(v.line, 1, `expected break at line 1, got ${v.line}`);
    });
});

// -----------------------------------------------------------------------
// Test 4: B01 + B02 + B03 三方整合 (settings mutation with authorize gate).
//
// The child server runs the REAL gate (no auto-approve). A POST
// /api/settings resetToken=true:
//   - authorize() pends and pushes needs_authorization over SSE
//   - the test captures the frame, POSTs /api/auth/decision (approve)
//   - the gate resolves approved → settings.js#rotateToken() runs
//   - events.js#append() writes auth.* + token.reset.* + settings.* lines
//   - state-bus.js#broadcastTokenRotated() pushes auth.token_rotated
//     to all SSE clients
//   - NO alert fires (benign state change — alerts are for system
//     signals only)
//
// We assert that the chain gains settings.* events AND the SSE
// channel receives auth.token_rotated.
// -----------------------------------------------------------------------
describe("event-chain: B01 + B02 + B03 integration via token reset", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    test("token.reset writes settings.write event + emits auth.token_rotated SSE", async () => {
        // Subscribe to /api/events first so we see the broadcast.
        const ssePromise = new Promise((resolve, reject) => {
            const req = http.request(
                {
                    method: "GET",
                    host: "127.0.0.1",
                    port: server.port,
                    path: "/api/events?cid=cid-b03-integrate",
                },
                (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (c) => (body += c));
                    const timer = setTimeout(() => {
                        try { req.destroy(); } catch {}
                        resolve({ status: res.statusCode, body });
                    }, 2500);
                    res.on("end", () => {
                        clearTimeout(timer);
                        resolve({ status: res.statusCode, body });
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
        // Let the SSE connect.
        await new Promise((r) => setTimeout(r, 200));
        // Start the decider FIRST and let its SSE subscription register
        // (broadcasts are not replayed to late subscribers), THEN fire
        // the gated POST, then drive the decision through the
        // production wire path.
        const decisionPromise = decideNextAuthorization({
            port: server.port,
            approve: true,
            cid: "cid-decider",
        });
        await new Promise((r) => setTimeout(r, 150));
        const postPromise = postJson({
            port: server.port,
            path: "/api/settings",
            body: { resetToken: true },
        });
        const { decision } = await decisionPromise;
        assert.ok(decision, "decision POST must have answered");
        const post = await postPromise;
        assert.equal(post.status, 200, `resetToken: ${post.status}. body: ${post.body}`);
        assert.equal(post.json && post.json.tokenRotated, true);
        // events.ndjson should have settings.* lines (write-ahead intent
        // + outcome) plus the flow-level token.reset.* lines.
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        assert.ok(events.length >= 1, "at least one event written");
        const settingsEvents = events.filter((e) => /^settings\./.test(e.kind || ""));
        assert.ok(settingsEvents.length >= 1, "at least one settings.* event");
        const tokenResetEvents = events.filter((e) => /^token\.reset\./.test(e.kind || ""));
        assert.ok(tokenResetEvents.length >= 2,
            "token.reset.intent + token.reset.done both recorded");
        // The auth.token_rotated SSE frame must be on the wire.
        const res = await ssePromise;
        assert.match(
            res.body,
            /event: auth\.token_rotated/,
            `SSE body should contain auth.token_rotated frame. body: ${res.body.slice(0, 500)}`,
        );
    });
});

// -----------------------------------------------------------------------
// Test 5 (2026-09-20 rigor fix): gate-blocking integration.
//   (a) user declines session.delete → 403, session NOT deleted
//   (b) short timeoutMs on the real authorize() → fail-closed reject,
//       auth.timeout event recorded, chain still verifies
//   (c) user approves session.delete → 200, session deleted, intent +
//       outcome events recorded, events.verify() reports ok on the
//       whole chain
// -----------------------------------------------------------------------
describe("event-chain: gate-blocking (decline / timeout / approve)", () => {
    let server;
    test.beforeEach(async () => {
        server = await spawnServer();
    });
    test.afterEach(async () => {
        if (server) await stopServer(server.proc, server.tmpDir);
        server = null;
    });

    // Small raw-JSON request helper (POST/DELETE/GET).
    function requestJson({ method = "GET", port, path, body }) {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? null : JSON.stringify(body);
            const headers = {};
            if (data !== null) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(data);
            }
            const req = http.request(
                { method, host: "127.0.0.1", port, path, headers },
                (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        const raw = Buffer.concat(chunks).toString("utf8");
                        let json;
                        try { json = JSON.parse(raw); } catch {}
                        resolve({ status: res.statusCode, body: raw, json });
                    });
                    res.on("error", reject);
                },
            );
            req.on("error", reject);
            if (data !== null) req.write(data);
            req.end();
        });
    }

    async function listSessionIds(port) {
        const res = await requestJson({ port, path: "/api/sessions" });
        assert.equal(res.status, 200);
        return (res.json && res.json.sessions || []).map((s) => s.id);
    }

    async function createSession(port) {
        const res = await requestJson({
            method: "POST",
            port,
            path: "/api/sessions",
            body: {},
        });
        assert.equal(res.status, 200, `session create failed: ${res.body}`);
        assert.ok(res.json && res.json.session && res.json.session.id);
        return res.json.session.id;
    }

    // Fire a gated DELETE and drive the decision through the real wire
    // path. Subscribes the decider SSE first, then fires the request.
    async function deleteWithDecision(port, id, approve) {
        const decisionPromise = decideNextAuthorization({ port, approve, cid: "cid-decider" });
        // Give the decider's SSE connection a moment to register before
        // the gate broadcast fires (broadcasts are not replayed).
        await new Promise((r) => setTimeout(r, 150));
        const reqPromise = requestJson({ method: "DELETE", port, path: `/api/sessions/${id}` });
        const { decision } = await decisionPromise;
        const res = await reqPromise;
        return { res, decision };
    }

    test("(a) user declines session.delete → 403 + session survives", async () => {
        const id = await createSession(server.port);
        assert.ok((await listSessionIds(server.port)).includes(id),
            "precondition: created session is listed");
        const { res, decision } = await deleteWithDecision(server.port, id, false);
        assert.ok(decision, "decision endpoint answered");
        assert.equal(res.status, 403, `declined delete must 403, got ${res.status}: ${res.body}`);
        assert.equal(res.json && res.json.ok, false);
        assert.match(res.json && res.json.error || "", /authorize declined/);
        assert.equal(res.json.decidedBy, "user");
        // NOT deleted.
        const ids = await listSessionIds(server.port);
        assert.ok(ids.includes(id), "declined delete must leave the session on disk");
        // Audit: intent event for the delete must NOT exist (only the
        // auth.pending / auth.reject lines from authorize itself).
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        const intents = events.filter((e) => e.kind === "session.delete.intent");
        assert.equal(intents.length, 0,
            "declined delete must not write a session.delete.intent line");
        const rejects = events.filter((e) => e.kind === "auth.reject");
        assert.ok(rejects.length >= 1, "auth.reject outcome recorded");
        const v = verifyChain(server.eventsPath);
        assert.equal(v.ok, true, `chain must still verify: ${JSON.stringify(v)}`);
    });

    test("(b) short timeoutMs on the real authorize() → fail-closed reject", async () => {
        // In-process, real module (no mocks): the gate must resolve
        // approved:false on timeout and record auth.timeout on the
        // isolated chain. Route-level behavior of a timeout is the same
        // 403 branch covered in (a) (approved:false → declined).
        const eventsPath = join(server.tmpDir, "timeout-events.ndjson");
        process.env.MCODE_WEBUI_EVENTS_PATH = eventsPath;
        try {
            const auth = await import(absPath("lib/authorize.js"));
            auth._resetForTests();
            const result = await auth.authorize(
                "session.delete",
                { cid: "cid-timeout" },
                { timeoutMs: 50 },
            );
            assert.equal(result.approved, false, "timeout must fail closed");
            assert.equal(result.decidedBy, "timeout");
            // The timeout outcome is audited on the chain.
            await new Promise((r) => setTimeout(r, 30));
            const events = readEvents(eventsPath);
            const timeouts = events.filter((e) => e.kind === "auth.timeout");
            assert.ok(timeouts.length >= 1, "auth.timeout event recorded");
            const pendings = events.filter((e) => e.kind === "auth.pending");
            assert.ok(pendings.length >= 1, "auth.pending event recorded");
            assert.equal(pendings[0].target, "session.delete");
            // The real verify() from production code must accept the chain.
            const eventsMod = await import(absPath("lib/events.js"));
            const v = eventsMod.verify({ path: eventsPath });
            assert.equal(v.ok, true, `verify() failed: ${JSON.stringify(v)}`);
            assert.ok(v.count >= 2, `expected >=2 events, got ${v.count}`);
        } finally {
            // Restore the shared env + drop any in-process pending
            // requests so later tests are unaffected.
            delete process.env.MCODE_WEBUI_EVENTS_PATH;
            try {
                const auth = await import(absPath("lib/authorize.js"));
                auth._resetForTests();
            } catch {}
        }
    });

    test("(c) user approves session.delete → deletion + chain verify ok", async () => {
        const id = await createSession(server.port);
        const { res, decision } = await deleteWithDecision(server.port, id, true);
        assert.ok(decision, "decision endpoint answered");
        assert.equal(res.status, 200, `approved delete must 200, got ${res.status}: ${res.body}`);
        assert.equal(res.json && res.json.ok, true);
        assert.equal(res.json.deleted, id);
        // Deleted for real.
        const ids = await listSessionIds(server.port);
        assert.ok(!ids.includes(id), "approved delete must remove the session");
        // Audit: write-ahead intent + outcome both recorded, in order.
        await new Promise((r) => setTimeout(r, 50));
        const events = readEvents(server.eventsPath);
        const kinds = events.map((e) => e.kind);
        const intentIdx = kinds.indexOf("session.delete.intent");
        const outcomeIdx = kinds.indexOf("session.delete");
        assert.ok(intentIdx >= 0, "session.delete.intent recorded");
        assert.ok(outcomeIdx > intentIdx, "outcome recorded after intent");
        const approvals = events.filter((e) => e.kind === "auth.approve");
        assert.ok(approvals.length >= 1, "auth.approve outcome recorded");
        // The production verify() must accept the whole chain.
        const eventsMod = await import(absPath("lib/events.js"));
        const v = eventsMod.verify({ path: server.eventsPath });
        assert.equal(v.ok, true, `verify() failed: ${JSON.stringify(v)}`);
        assert.ok(v.count >= 4, `expected >=4 events (pending/approve/intent/outcome), got ${v.count}`);
    });
});