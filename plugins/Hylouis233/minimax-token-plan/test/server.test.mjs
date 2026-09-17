import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOOL_DEFINITIONS,
  executeTool,
  handleMessage,
  startServer,
} from "../server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "server.mjs");

async function mockApi(context) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) : null;
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader("Content-Type", "application/json");
    if (body?.q === "quota-limit") {
      response.end(JSON.stringify({
        base_resp: { status_code: 2056, status_msg: "Token Plan Hs_max 0/0 usage limit" },
        trace_id: "trace-quota",
      }));
      return;
    }
    if (body?.q === "oversized") {
      response.end(JSON.stringify({ value: "x".repeat(5 * 1024 * 1024 + 1) }));
      return;
    }
    if (body?.q === "echo-secret") {
      response.end(JSON.stringify({
        echoed: request.headers.authorization,
        base_resp: { status_code: 0, status_msg: "success" },
      }));
      return;
    }
    if (body?.q === "echo-secret-key") {
      response.end(JSON.stringify({
        [request.headers.authorization]: "secret appeared in an object key",
        ["k".repeat(20_000)]: "oversized object key",
        base_resp: { status_code: 0, status_msg: "success" },
      }));
      return;
    }
    if (body?.q === "auth-error") {
      response.statusCode = 401;
      response.end(JSON.stringify({
        error: { message: `invalid ${request.headers.authorization}` },
        request_id: "request-auth",
      }));
      return;
    }
    const result = request.url.startsWith("/v2/query/video_generation/")
      ? { task: { id: request.url.split("/").at(-1), status: "succeeded", content: { url: "https://cdn.example/video.mp4" } } }
      : request.url === "/v2/video_generation"
        ? { task_id: "task-123" }
        : request.url === "/v1/image_generation"
          ? { data: { image_urls: ["https://cdn.example/image.jpg"] }, base_resp: { status_code: 0, status_msg: "success" } }
          : request.url === "/v1/t2a_v2"
            ? { data: { audio: "https://cdn.example/audio.mp3", status: 2 }, base_resp: { status_code: 0, status_msg: "success" } }
            : request.url === "/v1/get_voice"
              ? { system_voice: [{ voice_id: "fixture-voice" }], base_resp: { status_code: 0, status_msg: "success" } }
              : request.url === "/v1/lyrics_generation"
                ? { song_title: "Fixture Song", lyrics: "[Verse]\nFixture", base_resp: { status_code: 0, status_msg: "success" } }
                : request.url === "/v1/music_generation"
                  ? { data: { audio: "https://cdn.example/music.mp3", status: 2 }, base_resp: { status_code: 0, status_msg: "success" } }
                  : request.url === "/v1/music_cover_preprocess"
                    ? { cover_feature_id: "cover-123", base_resp: { status_code: 0, status_msg: "success" } }
                    : request.url === "/v1/coding_plan/vlm"
                      ? { content: "fixture image description", base_resp: { status_code: 0, status_msg: "success" } }
                      : { organic: [{ title: "fixture result" }], base_resp: { status_code: 0, status_msg: "success" } };
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    requests,
    env: {
      MINIMAX_TOKEN_PLAN_API_KEY: "token-secret",
      MINIMAX_PAYGO_API_KEY: "paygo-secret",
    },
    apiHostOverride: `http://127.0.0.1:${port}`,
  };
}

function apiOptions(api) {
  return { env: api.env, apiHostOverride: api.apiHostOverride };
}

test("tool inventory covers Token Plan and optional multimodal workflows", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), [
    "minimax_get_capabilities",
    "minimax_web_search",
    "minimax_understand_image",
    "minimax_generate_image",
    "minimax_list_voices",
    "minimax_text_to_speech",
    "minimax_create_video",
    "minimax_query_video",
    "minimax_generate_lyrics",
    "minimax_generate_music",
    "minimax_preprocess_music_cover",
  ]);
  assert.ok(TOOL_DEFINITIONS.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.ok(TOOL_DEFINITIONS.every((tool) => typeof tool.title === "string" && tool.title.length > 0));
});

test("capabilities disclose key classes and boundaries without secrets or network", async () => {
  const capabilities = await executeTool("minimax_get_capabilities", {}, {
    env: {
      MINIMAX_TOKEN_PLAN_API_KEY: "do-not-leak-token",
      MINIMAX_PAYGO_API_KEY: "do-not-leak-paygo",
    },
    fetchImpl: () => { throw new Error("network must not be used"); },
  });
  assert.equal(capabilities.configured.token_plan, true);
  assert.equal(capabilities.configured.paygo, true);
  assert.ok(capabilities.token_plan.not_currently_covered.includes("MiniMax H3 video"));
  assert.doesNotMatch(JSON.stringify(capabilities), /do-not-leak/u);
});

test("costed tools require explicit confirmation before any request", async (context) => {
  const api = await mockApi(context);
  await assert.rejects(
    executeTool("minimax_generate_image", { prompt: "fixture" }, apiOptions(api)),
    /confirm_usage must be true/u,
  );
  assert.equal(api.requests.length, 0);
});

test("production host validation cannot be bypassed with test-looking environment variables", async () => {
  let requests = 0;
  await assert.rejects(executeTool("minimax_web_search", {
    query: "fixture", confirm_usage: true,
  }, {
    env: {
      NODE_ENV: "test",
      MINIMAX_MCP_TEST_API_HOST: "https://attacker.invalid",
      MINIMAX_API_HOST: "https://attacker.invalid",
      MINIMAX_TOKEN_PLAN_API_KEY: "must-not-leak",
    },
    fetchImpl: async () => { requests += 1; throw new Error("must not run"); },
  }), /MINIMAX_API_HOST must be/u);
  assert.equal(requests, 0);
});

test("Token Plan search, vision, image, voices, and speech use the token key", async (context) => {
  const api = await mockApi(context);
  const search = await executeTool("minimax_web_search", {
    query: "MiniMax documentation", confirm_usage: true,
  }, apiOptions(api));
  const vision = await executeTool("minimax_understand_image", {
    prompt: "Describe it", image_source: "https://example.com/image.png", confirm_usage: true,
  }, apiOptions(api));
  const image = await executeTool("minimax_generate_image", {
    prompt: "A safe fixture image", aspect_ratio: "16:9", n: 2, confirm_usage: true,
  }, apiOptions(api));
  const voices = await executeTool("minimax_list_voices", {}, apiOptions(api));
  const speech = await executeTool("minimax_text_to_speech", {
    text: "Fixture narration", confirm_usage: true,
  }, apiOptions(api));
  assert.equal(search.organic[0].title, "fixture result");
  assert.equal(vision.content, "fixture image description");
  assert.equal(image.data.image_urls[0], "https://cdn.example/image.jpg");
  assert.equal(voices.system_voice[0].voice_id, "fixture-voice");
  assert.equal(speech.data.audio, "https://cdn.example/audio.mp3");
  assert.deepEqual(api.requests.map((request) => request.url), [
    "/v1/coding_plan/search", "/v1/coding_plan/vlm", "/v1/image_generation",
    "/v1/get_voice", "/v1/t2a_v2",
  ]);
  assert.ok(api.requests.every((request) => request.authorization === "Bearer token-secret"));
  assert.equal(api.requests[2].body.response_format, "url");
  assert.equal(api.requests[4].body.output_format, "url");
});

test("vision rejects local paths and video rejects mixed generation modes", async (context) => {
  const api = await mockApi(context);
  await assert.rejects(executeTool("minimax_understand_image", {
    prompt: "read", image_source: "C:\\secret.png", confirm_usage: true,
  }, apiOptions(api)), /HTTPS URL/u);
  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "fixture", first_frame_url: "https://example.com/a.png",
    reference_image_urls: ["https://example.com/b.png"], confirm_usage: true,
  }, apiOptions(api)), /cannot be mixed/u);
  assert.equal(api.requests.length, 0);
});


test("media schemas fit the stdio frame and reference collections remain HTTPS-only", async (context) => {
  const api = await mockApi(context);
  const vision = TOOL_DEFINITIONS.find((tool) => tool.name === "minimax_understand_image");
  const image = TOOL_DEFINITIONS.find((tool) => tool.name === "minimax_generate_image");
  const video = TOOL_DEFINITIONS.find((tool) => tool.name === "minimax_create_video");
  const visionSource = vision.inputSchema.properties.image_source;
  const subjectSource = image.inputSchema.properties.subject_reference_url;
  const videoProps = video.inputSchema.properties;
  const inlineMax = (schema) => Math.max(...schema.oneOf.map((entry) => entry.maxLength));
  assert.equal(inlineMax(visionSource), 900_000);
  assert.equal(inlineMax(subjectSource), 900_000);
  assert.equal(inlineMax(videoProps.first_frame_url), 430_000);
  assert.equal(inlineMax(videoProps.last_frame_url), 430_000);
  assert.equal(videoProps.reference_image_urls.items.maxLength, 4096);

  const dataUrl = (length) => {
    const prefix = "data:image/png;base64,";
    return prefix + "A".repeat(length - prefix.length);
  };
  const https = (length) => {
    const prefix = "https://example.com/";
    return prefix + "a".repeat(length - prefix.length);
  };
  const worstCase = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "minimax_create_video", arguments: {
      prompt: "p".repeat(2000),
      first_frame_url: dataUrl(430_000),
      last_frame_url: dataUrl(430_000),
      reference_image_urls: Array.from({ length: 9 }, () => https(4096)),
      reference_video_urls: Array.from({ length: 3 }, () => https(4096)),
      reference_audio_urls: Array.from({ length: 3 }, () => https(4096)),
      confirm_usage: true,
    } },
  });
  assert.ok(worstCase.length < 1_000_000);

  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "inline collection fixture",
    reference_image_urls: ["data:image/png;base64,AA=="],
    confirm_usage: true,
  }, apiOptions(api)), /HTTPS URL/u);
  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "overlong URL fixture",
    reference_video_urls: [https(4097)],
    confirm_usage: true,
  }, apiOptions(api)), /length must be between 1 and 4096/u);
  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "overlong frame fixture",
    first_frame_url: dataUrl(430_001),
    confirm_usage: true,
  }, apiOptions(api)), /length must be between 0 and 430000/u);
  assert.equal(api.requests.length, 0);
});

test("H3 video creation and query use only the paygo key", async (context) => {
  const api = await mockApi(context);
  const created = await executeTool("minimax_create_video", {
    prompt: "A five second fixture", confirm_usage: true,
  }, apiOptions(api));
  const queried = await executeTool("minimax_query_video", { task_id: created.task_id }, apiOptions(api));
  assert.equal(queried.task.status, "succeeded");
  assert.deepEqual(api.requests.map((request) => request.authorization), [
    "Bearer paygo-secret", "Bearer paygo-secret",
  ]);
  assert.equal(api.requests[0].body.model, "MiniMax-H3");
});

test("H3 exposes the documented duration, ratio, and reference-media bounds", async (context) => {
  const api = await mockApi(context);
  await executeTool("minimax_create_video", {
    prompt: "A production fixture",
    duration: 15,
    resolution: "768P",
    ratio: "21:9",
    reference_image_urls: Array.from({ length: 9 }, (_, index) => `https://example.com/image-${index}.png`),
    reference_video_urls: Array.from({ length: 3 }, (_, index) => `https://example.com/video-${index}.mp4`),
    reference_audio_urls: Array.from({ length: 3 }, (_, index) => `https://example.com/audio-${index}.mp3`),
    confirm_usage: true,
  }, apiOptions(api));
  assert.equal(api.requests[0].body.duration, 15);
  assert.equal(api.requests[0].body.ratio, "21:9");
  assert.equal(api.requests[0].body.content.length, 16);
  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "frame fixture",
    first_frame_url: "https://example.com/frame.png",
    ratio: "16:9",
    confirm_usage: true,
  }, apiOptions(api)), /ratio must be adaptive/u);
});

test("paygo-only tools fail closed when only a Token Plan key exists", async () => {
  await assert.rejects(executeTool("minimax_create_video", {
    prompt: "fixture", confirm_usage: true,
  }, { env: { MINIMAX_TOKEN_PLAN_API_KEY: "token-only" } }), /MINIMAX_PAYGO_API_KEY/u);
});

test("generic API keys require an explicit mode before paygo routing", async (context) => {
  const api = await mockApi(context);
  const env = { MINIMAX_API_KEY: "generic-secret", MINIMAX_API_KEY_MODE: "paygo" };
  const capabilities = await executeTool("minimax_get_capabilities", {}, { env });
  assert.deepEqual(capabilities.configured, { token_plan: false, paygo: true });
  await executeTool("minimax_create_video", {
    prompt: "generic paygo fixture", confirm_usage: true,
  }, { env, apiHostOverride: api.apiHostOverride });
  assert.equal(api.requests.at(-1).authorization, "Bearer generic-secret");
});

test("legacy lyrics, music, and cover tools preserve the lifecycle warning", async (context) => {
  const api = await mockApi(context);
  const lyricsResponse = await handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "minimax_generate_lyrics", arguments: {
      mode: "write_full_song", prompt: "fixture song", confirm_usage: true,
    } },
  }, apiOptions(api));
  const musicResponse = await handleMessage({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "minimax_generate_music", arguments: {
      prompt: "fixture music", lyrics: "[Verse]\nFixture lyric", confirm_usage: true,
    } },
  }, apiOptions(api));
  const coverResponse = await handleMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "minimax_preprocess_music_cover", arguments: {
      audio_url: "https://example.com/song.mp3", confirm_usage: true,
    } },
  }, apiOptions(api));
  for (const response of [lyricsResponse, musicResponse, coverResponse]) {
    assert.equal(response.result.structuredContent.ok, true);
    assert.match(response.result.structuredContent.warning, /2026-08-20/u);
  }
  assert.ok(api.requests.every((request) => request.authorization === "Bearer token-secret"));

  await executeTool("minimax_generate_music", {
    prompt: "paygo fallback fixture", lyrics: "[Verse]\nFallback", confirm_usage: true,
  }, {
    env: { MINIMAX_PAYGO_API_KEY: "paygo-only-secret" },
    apiHostOverride: api.apiHostOverride,
  });
  assert.equal(api.requests.at(-1).authorization, "Bearer paygo-only-secret");
});

test("quota and oversized responses become actionable bounded errors", async (context) => {
  const api = await mockApi(context);
  await assert.rejects(executeTool("minimax_web_search", {
    query: "quota-limit", confirm_usage: true,
  }, apiOptions(api)), /may not be covered|quota window/u);
  await assert.rejects(executeTool("minimax_web_search", {
    query: "oversized", confirm_usage: true,
  }, apiOptions(api)), /5 MiB MCP safety limit/u);
});

test("upstream responses cannot echo configured API keys into MCP context", async (context) => {
  const api = await mockApi(context);
  const response = await executeTool("minimax_web_search", {
    query: "echo-secret", confirm_usage: true,
  }, apiOptions(api));
  assert.equal(response.echoed, "Bearer <redacted-api-key>");
  assert.doesNotMatch(JSON.stringify(response), /token-secret|paygo-secret/u);
});

test("upstream object keys are redacted and bounded before entering MCP context", async (context) => {
  const api = await mockApi(context);
  const message = await handleMessage({
    jsonrpc: "2.0", id: 77, method: "tools/call",
    params: { name: "minimax_web_search", arguments: {
      query: "echo-secret-key", confirm_usage: true,
    } },
  }, apiOptions(api));
  const result = message.result.structuredContent.result;
  const keys = Object.keys(result);
  assert.ok(keys.includes("Bearer <redacted-api-key>"));
  assert.ok(keys.some((key) => key.includes("key characters omitted")));
  assert.ok(keys.every((key) => key.length < 600));
  assert.doesNotMatch(JSON.stringify(message), /token-secret|paygo-secret|k{1000}/u);
});

test("authentication errors are actionable and cannot echo the failed key", async (context) => {
  const api = await mockApi(context);
  await assert.rejects(executeTool("minimax_web_search", {
    query: "auth-error", confirm_usage: true,
  }, apiOptions(api)), (error) => {
    assert.match(error.message, /key region matches MINIMAX_API_HOST/u);
    assert.doesNotMatch(error.message, /token-secret/u);
    assert.equal(error.details.trace_id, "request-auth");
    return true;
  });
});

test("unterminated oversized JSON-RPC input is rejected before a full line is buffered", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk) => { captured += chunk; });
  startServer({ input, output });
  input.write("x".repeat(1_000_001));
  const deadline = Date.now() + 1_000;
  while (!captured.includes("\n") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(JSON.parse(captured.trim()).error.code, -32700);
  assert.match(captured, /1,000,000 character limit/u);
});

test("stdio server completes initialize, tools/list, and a local capability call", async (context) => {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, MINIMAX_TOKEN_PLAN_API_KEY: "stdio-token" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "minimax_get_capabilities", arguments: {} },
  }) + "\n");
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("server exited " + code)));
  });
  assert.equal(responses[0].result.serverInfo.name, "minimax-token-plan-mcp-server");
  assert.equal(responses[1].result.tools.length, TOOL_DEFINITIONS.length);
  assert.equal(responses[2].result.structuredContent.result.configured.token_plan, true);
});
