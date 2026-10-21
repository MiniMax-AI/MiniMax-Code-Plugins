// webui/test/matrix/transports.test.js
// D02 lease: cross-transport matrix smoke test.
//
// The mcode binary supports three MCP-style transports (stdio / SSE /
// streamable-http). The webui currently consumes stream-json over stdio
// (mcode-exec.js). This matrix verifies that a minimal mock of each
// transport shape is decodable end-to-end by the harness — so when the
// operator switches MCODE_CMD to a streamable-http binary (or an SSE
// relay), the wire shape is what we expect.
//
// We test the protocol in isolation rather than spinning the full webui
// server because:
//   - The full server's mcode invocation requires a real mcode binary
//     on PATH (we're in a worker env without one).
//   - The matrix's purpose is to lock down the wire shape — what bytes
//     the server would see, and how those bytes should be parsed.
//   - We spawn one mock subprocess / mini HTTP server per transport,
//     exercise at least one happy path, and assert the decoded shape.
//
// What "happy path" means per transport:
//   stdio:
//     mock subprocess reads prompt from stdin, writes stream-json
//     frames to stdout, then exits 0. We assert the parser sees
//     {type:"result", content:"..."} and accumulates the answer.
//   sse:
//     mock HTTP server responds to GET /events with text/event-stream
//     frames (data: <json>\n\n). We open the stream, read 2 frames,
//     and assert the JSON shape is preserved.
//   streamable-http:
//     mock HTTP server accepts POST /messages and responds with the
//     same JSON-RPC 2.0 envelope mcode would. We POST a small
//     payload, parse the response, assert the envelope.

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = join(import.meta.url.replace(/^file:\/\//, "").replace(/\/[^/]*$/, ""));

// =======================================================================
// stdio transport
// =======================================================================
describe("matrix: stdio transport (line-delimited stream-json)", () => {
    test("mock mcode subprocess parses stream-json frames and accumulates answer", async () => {
        // Write a tiny mock mcode that reads prompt from stdin, writes
        // 3 stream-json frames to stdout, and exits 0. The script
        // lives in the OS temp dir so a real mcode install on PATH
        // never collides.
        const tmpDir = mkdtempSync(join(tmpdir(), "mcode-webui-mock-"));
        const mockPath = join(tmpDir, "mock-mcode-stdio.mjs");
        writeFileSync(
            mockPath,
            `#!/usr/bin/env node
// Mock mcode binary — stream-json over stdio.
// Reads prompt from stdin (until EOF), then writes stream-json
// frames to stdout and exits 0. Mirrors the wire shape mcode-exec.js
// expects (server/lib/mcode-exec.js#collectExecResult, lines 76-200).
let buf = "";
process.stdin.on("data", (c) => (buf += c.toString()));
process.stdin.on("end", () => {
  const prompt = buf.trim();
  // Frame 1: session init
  process.stdout.write(JSON.stringify({
    type: "session", session_id: "mvs_test_abcdef0123456789abcdef012345", ts: Date.now()
  }) + "\\n");
  // Frame 2: assistant delta
  process.stdout.write(JSON.stringify({
    type: "assistant", content: "echo: " + prompt.slice(0, 20)
  }) + "\\n");
  // Frame 3: final result
  process.stdout.write(JSON.stringify({
    type: "result", content: "done", session_id: "mvs_test_abcdef0123456789abcdef012345", usage: { input: 5, output: 7 }
  }) + "\\n");
  process.exit(0);
});
`,
            { mode: 0o755 },
        );
        // Spawn the mock as if it were the mcode binary.
        const proc = spawn("node", [mockPath], { stdio: ["pipe", "pipe", "pipe"] });
        proc.stdin.write("hello world from matrix test");
        proc.stdin.end();
        // Parse frames (mirror of mcode-exec.js#collectExecResult).
        let stdoutBuf = "";
        const frames = [];
        let sessionId = null;
        let answer = null;
        const exitCode = await new Promise((resolve) => {
            proc.stdout.on("data", (c) => {
                stdoutBuf += c.toString();
                let nl;
                while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
                    const line = stdoutBuf.slice(0, nl).trim();
                    stdoutBuf = stdoutBuf.slice(nl + 1);
                    if (!line) continue;
                    try {
                        const obj = JSON.parse(line);
                        frames.push(obj);
                        if (obj.type === "session" && obj.session_id) sessionId = obj.session_id;
                        if (obj.type === "result") answer = obj.content;
                    } catch {
                        // skip malformed
                    }
                }
            });
            proc.on("exit", (code) => resolve(code));
        });
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        assert.equal(exitCode, 0, `mock exited cleanly, got ${exitCode}`);
        assert.equal(frames.length, 3, `expected 3 stream-json frames, got ${frames.length}`);
        assert.equal(frames[0].type, "session");
        assert.equal(typeof sessionId, "string");
        assert.match(sessionId, /^mvs_/, "session_id is mvs_ prefixed");
        assert.equal(frames[1].type, "assistant");
        assert.equal(frames[2].type, "result");
        assert.equal(answer, "done", "result.content decoded");
        assert.deepEqual(frames[2].usage, { input: 5, output: 7 }, "usage payload intact");
    });
});

// =======================================================================
// SSE transport
// =======================================================================
describe("matrix: sse transport (HTTP + SSE long connection)", () => {
    test("GET on SSE endpoint yields data: <json>\\n\\n stream", async () => {
        // Start a tiny HTTP server that responds to GET /events with
        // a stream of JSON frames (mirrors an mcode SSE relay).
        const server = http.createServer((req, res) => {
            if (req.method === "GET" && req.url === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                });
                // 2 frames spaced 50ms apart.
                res.write(`data: ${JSON.stringify({ type: "session", session_id: "mvs_sse_001" })}\n\n`);
                setTimeout(() => {
                    res.write(`data: ${JSON.stringify({ type: "result", content: "sse-ok" })}\n\n`);
                    // Don't close — let the client decide. We close
                    // after a short delay so the test's `end` event
                    // fires naturally.
                    setTimeout(() => res.end(), 100);
                }, 50);
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();

        // Open the stream — accumulate frames until close.
        const collected = await new Promise((resolve, reject) => {
            const req = http.request(
                { method: "GET", host: "127.0.0.1", port, path: "/events" },
                (res) => {
                    let body = "";
                    res.setEncoding("utf8");
                    res.on("data", (c) => (body += c));
                    res.on("end", () => resolve(body));
                    res.on("error", reject);
                },
            );
            req.on("error", reject);
            req.end();
        });
        await new Promise((r) => server.close(r));
        // The body should contain two `data: {...}` lines.
        const dataLines = collected
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice("data: ".length));
        assert.equal(dataLines.length, 2, `expected 2 data: frames, got ${dataLines.length}`);
        const f1 = JSON.parse(dataLines[0]);
        const f2 = JSON.parse(dataLines[1]);
        assert.equal(f1.type, "session");
        assert.equal(f1.session_id, "mvs_sse_001");
        assert.equal(f2.type, "result");
        assert.equal(f2.content, "sse-ok");
    });
});

// =======================================================================
// streamable-http transport (JSON-RPC 2.0 over HTTP POST, bidirectional)
// =======================================================================
describe("matrix: streamable-http transport (JSON-RPC 2.0 POST)", () => {
    test("POST /messages returns JSON-RPC envelope; can carry session_id", async () => {
        // Mirror an mcode streamable-http endpoint that accepts POSTs
        // and replies with a JSON-RPC 2.0 response. The webui would
        // POST a `message` and the server returns the result with
        // session_id, content, etc.
        const server = http.createServer((req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                return res.end();
            }
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                let envelope;
                try {
                    envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                } catch {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({
                        jsonrpc: "2.0",
                        error: { code: -32700, message: "parse error" },
                        id: null,
                    }));
                }
                // Echo back the message with id + a result.
                const response = {
                    jsonrpc: "2.0",
                    id: envelope.id || null,
                    result: {
                        type: "result",
                        content: "streamable-http-ok",
                        session_id: "mvs_sh_001",
                        // Echo the prompt text the client sent so the
                        // test can verify request → response linkage.
                        echoed: envelope && envelope.params && envelope.params.message,
                    },
                };
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(response));
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();

        const postBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "message",
            params: { message: "hi from matrix" },
        });
        const result = await new Promise((resolve, reject) => {
            const req = http.request(
                {
                    method: "POST",
                    host: "127.0.0.1",
                    port,
                    path: "/messages",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(postBody),
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                        } catch (e) {
                            reject(e);
                        }
                    });
                    res.on("error", reject);
                },
            );
            req.on("error", reject);
            req.write(postBody);
            req.end();
        });
        await new Promise((r) => server.close(r));
        // JSON-RPC envelope assertions.
        assert.equal(result.jsonrpc, "2.0");
        assert.equal(result.id, 1, "id round-trips");
        assert.ok(result.result, "result envelope present");
        assert.equal(result.result.type, "result");
        assert.equal(result.result.content, "streamable-http-ok");
        assert.equal(result.result.session_id, "mvs_sh_001");
        assert.equal(result.result.echoed, "hi from matrix", "request params round-tripped");
    });
});