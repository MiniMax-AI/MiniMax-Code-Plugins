#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "minimax-token-plan-mcp-server";
const SERVER_VERSION = "0.1.0";
const MAX_LINE_CHARS = 1_000_000;
const MAX_INLINE_IMAGE_CHARS = 900_000;
const MAX_VIDEO_FRAME_IMAGE_CHARS = 430_000;
const MAX_REMOTE_URL_CHARS = 4096;
const MAX_OUTPUT_KEY_CHARS = 512;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const OFFICIAL_HOSTS = new Set([
  "https://api.minimax.io",
  "https://api.minimaxi.com",
]);
const LEGACY_MUSIC_WARNING =
  "MiniMax stopped offering paid Music and Lyrics APIs to new users on 2026-08-20; " +
  "this call is only expected to work for an existing eligible paying account.";

const JSON_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    tool: { type: "string" },
    result: {},
    warning: { type: ["string", "null"] },
  },
  required: ["ok", "tool", "result", "warning"],
  additionalProperties: false,
};

const CONFIRM_USAGE = {
  type: "boolean",
  const: true,
  description: "Must be true after the user explicitly confirms quota, Credits, or balance use.",
};

const HTTPS_URL_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: MAX_REMOTE_URL_CHARS,
  pattern: "^[Hh][Tt][Tt][Pp][Ss]://",
};

function mediaSourceSchema(maxInline, description) {
  return {
    oneOf: [
      { ...HTTPS_URL_SCHEMA },
      {
        type: "string",
        minLength: 1,
        maxLength: maxInline,
        pattern: "^data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$",
      },
    ],
    description,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "minimax_get_capabilities",
    description:
      "Report configured MiniMax key classes and documented Token Plan/paygo coverage without making a network request or revealing keys. Use before any other MiniMax tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "minimax_web_search",
    description:
      "Search the web through the official Token Plan coding_plan/search endpoint. Consumes Token Plan quota; use only after explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query." },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["query", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_understand_image",
    description:
      "Analyze one JPEG, PNG, or WebP image through the Token Plan vision endpoint. Accepts an HTTPS URL or bounded data-image URL, never a local path. Consumes quota and submits media to MiniMax.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 2000, description: "Question or extraction instruction." },
        image_source: mediaSourceSchema(MAX_INLINE_IMAGE_CHARS, "HTTPS URL or bounded data:image/jpeg|png|webp;base64 URL."),
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["prompt", "image_source", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_generate_image",
    description:
      "Generate one or more images with the current MiniMax image-01 model. Token Plan key is preferred and paygo is used only when no Token Plan key is configured. Creates remote output and consumes quota or balance.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 1500, description: "Detailed image prompt." },
        model: { type: "string", enum: ["image-01"], default: "image-01" },
        aspect_ratio: { type: "string", enum: ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"], default: "1:1" },
        n: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        prompt_optimizer: { type: "boolean", default: true },
        subject_reference_url: mediaSourceSchema(MAX_INLINE_IMAGE_CHARS, "Optional HTTPS or bounded data-image character reference."),
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["prompt", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_list_voices",
    description:
      "List voices visible to the configured eligible Token Plan or paygo key. This is read-only and does not synthesize audio.",
    inputSchema: {
      type: "object",
      properties: {
        voice_type: { type: "string", enum: ["system", "voice_cloning", "voice_generation", "music_generation", "all"], default: "all" },
      },
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "minimax_text_to_speech",
    description:
      "Synthesize speech with an eligible Token Plan or paygo key. Defaults to speech-2.8-hd and URL output to keep binary audio out of MCP context. Consumes quota or balance.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 9999 },
        voice_id: { type: "string", minLength: 1, maxLength: 256, default: "Chinese (Mandarin)_Reliable_Executive" },
        model: { type: "string", enum: ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo"], default: "speech-2.8-hd" },
        speed: { type: "number", minimum: 0.5, maximum: 2, default: 1 },
        volume: { type: "number", exclusiveMinimum: 0, maximum: 10, default: 1 },
        pitch: { type: "integer", minimum: -12, maximum: 12, default: 0 },
        sample_rate: { type: "integer", enum: [8000, 16000, 22050, 24000, 32000, 44100], default: 32000 },
        bitrate: { type: "integer", enum: [32000, 64000, 128000, 256000], default: 128000 },
        format: { type: "string", enum: ["mp3", "wav", "flac"], default: "mp3" },
        language_boost: { type: "string", minLength: 1, maxLength: 64, default: "auto" },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["text", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_create_video",
    description:
      "Create a MiniMax-H3 V2 video task with an explicit pay-as-you-go key. H3 is not a Token Plan entitlement. Frame inputs accept HTTPS or bounded inline images; reference collections require HTTPS. Returns a task ID and never polls automatically.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 2000 },
        resolution: { type: "string", enum: ["768P", "2K"], default: "2K" },
        duration: { type: "integer", minimum: 4, maximum: 15, default: 5 },
        ratio: { type: "string", enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] },
        first_frame_url: mediaSourceSchema(MAX_VIDEO_FRAME_IMAGE_CHARS, "HTTPS URL or bounded inline first-frame image."),
        last_frame_url: mediaSourceSchema(MAX_VIDEO_FRAME_IMAGE_CHARS, "HTTPS URL or bounded inline last-frame image."),
        reference_image_urls: { type: "array", maxItems: 9, items: { ...HTTPS_URL_SCHEMA }, description: "HTTPS reference-image URLs; inline data images are intentionally excluded from collections." },
        reference_video_urls: { type: "array", maxItems: 3, items: { ...HTTPS_URL_SCHEMA } },
        reference_audio_urls: { type: "array", maxItems: 3, items: { ...HTTPS_URL_SCHEMA } },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["prompt", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_query_video",
    description: "Query one MiniMax-H3 video task by task ID with the configured pay-as-you-go key. Does not create, cancel, or delete a task.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "minimax_generate_lyrics",
    description:
      "Generate, continue, or edit song lyrics for an existing eligible Token Plan or paying MiniMax account. New-user API access ended 2026-08-20. Prefers a Token Plan key and requires confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["write_full_song", "edit"] },
        prompt: { type: "string", maxLength: 2000 },
        lyrics: { type: "string", maxLength: 3500 },
        title: { type: "string", maxLength: 256 },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["mode", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_generate_music",
    description:
      "Generate music for an existing eligible Token Plan or paying MiniMax account. New-user API access ended 2026-08-20. Prefers a Token Plan key, requests URL output, and requires confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", enum: ["music-3.0", "music-2.6", "music-cover"], default: "music-3.0" },
        prompt: { type: "string", minLength: 1, maxLength: 2000 },
        lyrics: { type: "string", maxLength: 3500 },
        lyrics_optimizer: { type: "boolean", default: false },
        is_instrumental: { type: "boolean", default: false },
        audio_url: { ...HTTPS_URL_SCHEMA },
        cover_feature_id: { type: "string", minLength: 1, maxLength: 256 },
        sample_rate: { type: "integer", enum: [16000, 24000, 32000, 44100], default: 44100 },
        bitrate: { type: "integer", enum: [32000, 64000, 128000, 256000], default: 256000 },
        format: { type: "string", enum: ["mp3", "wav", "pcm"], default: "mp3" },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["prompt", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "minimax_preprocess_music_cover",
    description:
      "Preprocess one HTTPS reference audio URL for a grandfathered Token Plan or paid MiniMax music-cover workflow. Sends the URL to MiniMax and requires explicit confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        audio_url: { ...HTTPS_URL_SCHEMA },
        confirm_usage: CONFIRM_USAGE,
      },
      required: ["audio_url", "confirm_usage"],
      additionalProperties: false,
    },
    outputSchema: JSON_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const TOOL_TITLES = {
  minimax_get_capabilities: "Inspect MiniMax Capability Routing",
  minimax_web_search: "Search the Web with Token Plan",
  minimax_understand_image: "Understand an Image with Token Plan",
  minimax_generate_image: "Generate MiniMax Images",
  minimax_list_voices: "List MiniMax Voices",
  minimax_text_to_speech: "Synthesize MiniMax Speech",
  minimax_create_video: "Create a MiniMax H3 Video Task",
  minimax_query_video: "Query a MiniMax H3 Video Task",
  minimax_generate_lyrics: "Generate or Edit MiniMax Lyrics",
  minimax_generate_music: "Generate MiniMax Music",
  minimax_preprocess_music_cover: "Preprocess a MiniMax Music Cover",
};
for (const tool of TOOL_DEFINITIONS) tool.title = TOOL_TITLES[tool.name];

const TOOLS = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

class ToolInputError extends Error {}

class MiniMaxApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError("arguments must be an object");
  }
  return value;
}

function only(args, allowed) {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ToolInputError("unknown arguments: " + unknown.join(", "));
}

function stringArg(args, name, { required = false, min = 0, max = Infinity, fallback = undefined } = {}) {
  if (!own(args, name) || args[name] === undefined || args[name] === null) {
    if (required) throw new ToolInputError(name + " is required");
    return fallback;
  }
  if (typeof args[name] !== "string") throw new ToolInputError(name + " must be a string");
  const value = args[name];
  if (value.length < min || value.length > max) {
    throw new ToolInputError(`${name} length must be between ${min} and ${max}`);
  }
  return value;
}

function numberArg(args, name, { min = -Infinity, max = Infinity, integer = false, choices = null, fallback } = {}) {
  if (!own(args, name) || args[name] === undefined || args[name] === null) return fallback;
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new ToolInputError(name + " must be " + (integer ? "an integer" : "a number"));
  }
  if (value < min || value > max || (choices && !choices.includes(value))) {
    throw new ToolInputError(name + " is outside the supported range");
  }
  return value;
}

function booleanArg(args, name, fallback) {
  if (!own(args, name) || args[name] === undefined || args[name] === null) return fallback;
  if (typeof args[name] !== "boolean") throw new ToolInputError(name + " must be boolean");
  return args[name];
}

function enumArg(args, name, choices, fallback) {
  const value = stringArg(args, name, { fallback });
  if (!choices.includes(value)) throw new ToolInputError(`${name} must be one of: ${choices.join(", ")}`);
  return value;
}

function confirmed(args) {
  if (args.confirm_usage !== true) {
    throw new ToolInputError("confirm_usage must be true after the user explicitly confirms quota or balance use");
  }
}

function mediaSource(value, name = "media source", { maxInline = MAX_INLINE_IMAGE_CHARS } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(name + " must be a non-empty string");
  }
  if (value.startsWith("data:image/")) {
    if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/u.test(value)) {
      throw new ToolInputError(name + " must be a JPEG, PNG, or WebP base64 data URL");
    }
    if (value.length > maxInline) {
      throw new ToolInputError(name + ` exceeds the ${maxInline.toLocaleString("en-US")} character inline-image limit; use HTTPS for larger media`);
    }
    return value;
  }
  return httpsUrl(value, name);
}

function httpsUrl(value, name = "URL", max = MAX_REMOTE_URL_CHARS) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    throw new ToolInputError(`${name} length must be between 1 and ${max}`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolInputError(name + " must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ToolInputError(name + " must be an HTTPS URL without embedded credentials");
  }
  return parsed.toString();
}

function configuration(env = process.env, apiHostOverride = null) {
  const mode = env.MINIMAX_API_KEY_MODE || "token-plan";
  if (!new Set(["token-plan", "paygo"]).has(mode)) {
    throw new ToolInputError("MINIMAX_API_KEY_MODE must be token-plan or paygo");
  }
  const generic = env.MINIMAX_API_KEY || "";
  const tokenPlanKey = env.MINIMAX_TOKEN_PLAN_API_KEY || (mode === "token-plan" ? generic : "");
  const paygoKey = env.MINIMAX_PAYGO_API_KEY || (mode === "paygo" ? generic : "");
  let apiHost = apiHostOverride || env.MINIMAX_API_HOST || "https://api.minimax.io";
  if (!apiHostOverride) {
    apiHost = apiHost.replace(/\/+$/u, "");
    if (!OFFICIAL_HOSTS.has(apiHost)) {
      throw new ToolInputError(
        "MINIMAX_API_HOST must be https://api.minimax.io or https://api.minimaxi.com",
      );
    }
  }
  return { mode, tokenPlanKey, paygoKey, apiHost: apiHost.replace(/\/+$/u, "") };
}

function keyFor(kind, config) {
  const key = kind === "token"
    ? config.tokenPlanKey
    : kind === "paygo"
      ? config.paygoKey
      : config.tokenPlanKey || config.paygoKey;
  if (key) return key;
  if (kind === "token") {
    throw new ToolInputError("configure MINIMAX_TOKEN_PLAN_API_KEY for this Token Plan tool");
  }
  if (kind === "paygo") {
    throw new ToolInputError(
      "configure MINIMAX_PAYGO_API_KEY; this endpoint is not included in current Token Plan coverage",
    );
  }
  throw new ToolInputError("configure a Token Plan or pay-as-you-go MiniMax API key");
}

async function readBoundedJson(response) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MiniMaxApiError("MiniMax response exceeded the 5 MiB MCP safety limit");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new MiniMaxApiError("MiniMax returned a non-JSON response", { http_status: response.status });
  }
}

function apiMessage(payload) {
  return payload?.error?.message || payload?.base_resp?.status_msg || payload?.message || "API request failed";
}

function redactSecrets(value, secrets, depth = 0) {
  if (depth > 12) return "<maximum nesting omitted>";
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) => secret ? text.split(secret).join("<redacted-api-key>") : text,
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        redactSecrets(name, secrets, depth + 1),
        redactSecrets(item, secrets, depth + 1),
      ]),
    );
  }
  return value;
}

async function apiRequest(path, { method = "POST", body = undefined, keyKind = "eligible", env = process.env, fetchImpl = fetch, apiHostOverride = null } = {}) {
  const config = configuration(env, apiHostOverride);
  const key = keyFor(keyKind, config);
  let response;
  try {
    response = await fetchImpl(config.apiHost + path, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error?.name === "TimeoutError"
      ? "MiniMax request timed out; do not automatically retry a generation request"
      : "MiniMax network request failed: " + String(error?.message || error);
    throw new MiniMaxApiError(message);
  }
  const rawPayload = await readBoundedJson(response);
  const payload = redactSecrets(rawPayload, [key, config.tokenPlanKey, config.paygoKey]);
  const statusCode = payload?.base_resp?.status_code;
  if (!response.ok || (statusCode !== undefined && statusCode !== 0)) {
    const details = {
      http_status: response.status,
      status_code: statusCode ?? payload?.error?.code ?? null,
      trace_id: payload?.trace_id || payload?.request_id || null,
    };
    let message = apiMessage(payload);
    if (response.status === 401 || details.status_code === 1004) {
      message += "; verify that the API key region matches MINIMAX_API_HOST";
    } else if (response.status === 429 || details.status_code === 1002) {
      message += "; wait before retrying and retain the trace ID";
    } else if (details.status_code === 2056 || /usage limit|Hs_max/iu.test(message)) {
      message += "; the selected model may not be covered by this key or its quota window may be exhausted";
    }
    throw new MiniMaxApiError(message, details);
  }
  return payload;
}

function sanitizeKey(value) {
  const key = String(value);
  if (key.length <= MAX_OUTPUT_KEY_CHARS) return key;
  const kept = 256;
  return key.slice(0, kept) + `<${key.length - kept} key characters omitted>`;
}

function sanitize(value, depth = 0) {
  if (depth > 8) return "<maximum nesting omitted>";
  if (typeof value === "string") {
    if (value.length <= 12_000) return value;
    return value.slice(0, 1_000) + `<${value.length - 1_000} characters omitted>`;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeKey(key), sanitize(item, depth + 1)]),
    );
  }
  return value;
}

function success(tool, result, warning = null) {
  const structuredContent = { ok: true, tool, result: sanitize(result), warning };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: false,
  };
}

function failure(tool, error) {
  const errorResult = {
    error: {
      type: error instanceof ToolInputError ? "invalid_arguments" : "api_error",
      message: String(error?.message || error),
      ...(error instanceof MiniMaxApiError ? error.details : {}),
    },
  };
  const structuredContent = { ok: false, tool, result: errorResult, warning: null };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true,
  };
}

function capabilities(env) {
  let config;
  try {
    config = configuration(env);
  } catch (error) {
    return { configuration_error: error.message };
  }
  const token = Boolean(config.tokenPlanKey);
  const paygo = Boolean(config.paygoKey);
  return {
    documented_as_of: "2026-08-21",
    api_host: config.apiHost,
    key_mode: config.mode,
    configured: { token_plan: token, paygo },
    token_plan: {
      documented_coverage: ["M3/M2.7 text", "image", "speech"],
      tools: {
        web_search: token,
        understand_image: token,
        image_generation: token,
        list_voices: token,
        text_to_speech: token,
      },
      grandfathered_if_account_eligible: ["Music Generation API", "Lyrics Generation API", "music cover"],
      not_currently_covered: ["MiniMax H3 video", "voice design", "rapid voice cloning"],
    },
    optional_paygo: {
      configured: paygo,
      tools: ["MiniMax H3 video"],
      legacy_only: ["Music Generation API", "Lyrics Generation API", "music cover"],
    },
    music_api_notice: LEGACY_MUSIC_WARNING,
    note: "Configuration presence is not a live entitlement probe; the API remains authoritative.",
  };
}

export async function executeTool(name, rawArgs = {}, options = {}) {
  const args = objectArgs(rawArgs);
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const apiHostOverride = options.apiHostOverride || null;
  if (name === "minimax_get_capabilities") {
    only(args, []);
    return capabilities(env);
  }
  if (name === "minimax_web_search") {
    only(args, ["query", "confirm_usage"]); confirmed(args);
    const query = stringArg(args, "query", { required: true, min: 1, max: 500 });
    return await apiRequest("/v1/coding_plan/search", { body: { q: query }, keyKind: "token", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_understand_image") {
    only(args, ["prompt", "image_source", "confirm_usage"]); confirmed(args);
    const prompt = stringArg(args, "prompt", { required: true, min: 1, max: 2000 });
    const imageSource = mediaSource(stringArg(args, "image_source", { required: true, min: 1, max: MAX_INLINE_IMAGE_CHARS }), "image_source");
    return await apiRequest("/v1/coding_plan/vlm", { body: { prompt, image_url: imageSource }, keyKind: "token", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_generate_image") {
    only(args, ["prompt", "model", "aspect_ratio", "n", "prompt_optimizer", "subject_reference_url", "confirm_usage"]); confirmed(args);
    const body = {
      model: enumArg(args, "model", ["image-01"], "image-01"),
      prompt: stringArg(args, "prompt", { required: true, min: 1, max: 1500 }),
      aspect_ratio: enumArg(args, "aspect_ratio", ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"], "1:1"),
      n: numberArg(args, "n", { integer: true, min: 1, max: 9, fallback: 1 }),
      prompt_optimizer: booleanArg(args, "prompt_optimizer", true),
      response_format: "url",
    };
    const reference = stringArg(args, "subject_reference_url", { max: MAX_INLINE_IMAGE_CHARS });
    if (reference) body.subject_reference = [{ type: "character", image_file: mediaSource(reference, "subject_reference_url") }];
    return await apiRequest("/v1/image_generation", { body, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_list_voices") {
    only(args, ["voice_type"]);
    const voiceType = enumArg(args, "voice_type", ["system", "voice_cloning", "voice_generation", "music_generation", "all"], "all");
    return await apiRequest("/v1/get_voice", { body: { voice_type: voiceType }, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_text_to_speech") {
    only(args, ["text", "voice_id", "model", "speed", "volume", "pitch", "sample_rate", "bitrate", "format", "language_boost", "confirm_usage"]); confirmed(args);
    const body = {
      model: enumArg(args, "model", ["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo"], "speech-2.8-hd"),
      text: stringArg(args, "text", { required: true, min: 1, max: 9999 }),
      stream: false,
      output_format: "url",
      language_boost: stringArg(args, "language_boost", { min: 1, max: 64, fallback: "auto" }),
      voice_setting: {
        voice_id: stringArg(args, "voice_id", { min: 1, max: 256, fallback: "Chinese (Mandarin)_Reliable_Executive" }),
        speed: numberArg(args, "speed", { min: 0.5, max: 2, fallback: 1 }),
        vol: numberArg(args, "volume", { min: Number.MIN_VALUE, max: 10, fallback: 1 }),
        pitch: numberArg(args, "pitch", { integer: true, min: -12, max: 12, fallback: 0 }),
      },
      audio_setting: {
        sample_rate: numberArg(args, "sample_rate", { integer: true, choices: [8000, 16000, 22050, 24000, 32000, 44100], fallback: 32000 }),
        bitrate: numberArg(args, "bitrate", { integer: true, choices: [32000, 64000, 128000, 256000], fallback: 128000 }),
        format: enumArg(args, "format", ["mp3", "wav", "flac"], "mp3"),
        channel: 1,
      },
    };
    return await apiRequest("/v1/t2a_v2", { body, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_create_video") {
    only(args, ["prompt", "resolution", "duration", "ratio", "first_frame_url", "last_frame_url", "reference_image_urls", "reference_video_urls", "reference_audio_urls", "confirm_usage"]); confirmed(args);
    const content = [{ type: "text", text: stringArg(args, "prompt", { required: true, min: 1, max: 2000 }) }];
    const first = stringArg(args, "first_frame_url", { max: MAX_VIDEO_FRAME_IMAGE_CHARS });
    const last = stringArg(args, "last_frame_url", { max: MAX_VIDEO_FRAME_IMAGE_CHARS });
    const referenceImages = args.reference_image_urls ?? [];
    if (!Array.isArray(referenceImages) || referenceImages.length > 9 || referenceImages.some((item) => typeof item !== "string")) {
      throw new ToolInputError("reference_image_urls must be an array of at most nine strings");
    }
    const referenceVideos = args.reference_video_urls ?? [];
    const referenceAudios = args.reference_audio_urls ?? [];
    if (!Array.isArray(referenceVideos) || referenceVideos.length > 3 || referenceVideos.some((item) => typeof item !== "string")) {
      throw new ToolInputError("reference_video_urls must be an array of at most three strings");
    }
    if (!Array.isArray(referenceAudios) || referenceAudios.length > 3 || referenceAudios.some((item) => typeof item !== "string")) {
      throw new ToolInputError("reference_audio_urls must be an array of at most three strings");
    }
    if ((first || last) && (referenceImages.length || referenceVideos.length || referenceAudios.length)) {
      throw new ToolInputError("first/last-frame inputs cannot be mixed with reference media inputs");
    }
    if (first) content.push({ type: "image_url", image_url: { url: mediaSource(first, "first_frame_url", { maxInline: MAX_VIDEO_FRAME_IMAGE_CHARS }) }, role: "first_frame" });
    if (last) content.push({ type: "image_url", image_url: { url: mediaSource(last, "last_frame_url", { maxInline: MAX_VIDEO_FRAME_IMAGE_CHARS }) }, role: "last_frame" });
    for (const item of referenceImages) {
      content.push({ type: "image_url", image_url: { url: httpsUrl(item, "reference_image_urls item") }, role: "reference_image" });
    }
    for (const item of referenceVideos) {
      content.push({ type: "video_url", video_url: { url: httpsUrl(item, "reference_video_urls item") }, role: "reference_video" });
    }
    for (const item of referenceAudios) {
      content.push({ type: "audio_url", audio_url: { url: httpsUrl(item, "reference_audio_urls item") }, role: "reference_audio" });
    }
    const requestedRatio = own(args, "ratio")
      ? enumArg(args, "ratio", ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"])
      : null;
    let ratio;
    if (first || last) {
      if (requestedRatio && requestedRatio !== "adaptive") {
        throw new ToolInputError("ratio must be adaptive when first_frame_url or last_frame_url is used");
      }
      ratio = "adaptive";
    } else if (referenceImages.length || referenceVideos.length || referenceAudios.length) {
      ratio = requestedRatio || "adaptive";
    } else {
      if (requestedRatio === "adaptive") throw new ToolInputError("text-to-video requires a concrete ratio");
      ratio = requestedRatio || "16:9";
    }
    const body = {
      model: "MiniMax-H3",
      content,
      resolution: enumArg(args, "resolution", ["768P", "2K"], "2K"),
      duration: numberArg(args, "duration", { integer: true, min: 4, max: 15, fallback: 5 }),
      ratio,
    };
    return await apiRequest("/v2/video_generation", { body, keyKind: "paygo", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_query_video") {
    only(args, ["task_id"]);
    const taskId = stringArg(args, "task_id", { required: true, min: 1, max: 128 });
    if (!/^[A-Za-z0-9_-]+$/u.test(taskId)) throw new ToolInputError("task_id has invalid characters");
    return await apiRequest("/v2/query/video_generation/" + encodeURIComponent(taskId), { method: "GET", keyKind: "paygo", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_generate_lyrics") {
    only(args, ["mode", "prompt", "lyrics", "title", "confirm_usage"]); confirmed(args);
    const mode = enumArg(args, "mode", ["write_full_song", "edit"]);
    const body = {
      mode,
      prompt: stringArg(args, "prompt", { max: 2000, fallback: "" }),
    };
    const lyrics = stringArg(args, "lyrics", { max: 3500 });
    const title = stringArg(args, "title", { max: 256 });
    if (mode === "edit" && !lyrics) throw new ToolInputError("lyrics is required in edit mode");
    if (lyrics !== undefined) body.lyrics = lyrics;
    if (title !== undefined) body.title = title;
    return await apiRequest("/v1/lyrics_generation", { body, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_generate_music") {
    only(args, ["model", "prompt", "lyrics", "lyrics_optimizer", "is_instrumental", "audio_url", "cover_feature_id", "sample_rate", "bitrate", "format", "confirm_usage"]); confirmed(args);
    const model = enumArg(args, "model", ["music-3.0", "music-2.6", "music-cover"], "music-3.0");
    const lyrics = stringArg(args, "lyrics", { max: 3500 });
    const optimizer = booleanArg(args, "lyrics_optimizer", false);
    const instrumental = booleanArg(args, "is_instrumental", false);
    const audioUrl = stringArg(args, "audio_url", { max: MAX_REMOTE_URL_CHARS });
    const coverFeatureId = stringArg(args, "cover_feature_id", { max: 256 });
    if (model === "music-cover") {
      if (Boolean(audioUrl) === Boolean(coverFeatureId)) {
        throw new ToolInputError("music-cover requires exactly one of audio_url or cover_feature_id");
      }
    } else if (!lyrics && !optimizer && !instrumental) {
      throw new ToolInputError("lyrics is required unless lyrics_optimizer or is_instrumental is true");
    }
    const body = {
      model,
      prompt: stringArg(args, "prompt", { required: true, min: 1, max: 2000 }),
      lyrics: lyrics ?? "",
      lyrics_optimizer: optimizer,
      is_instrumental: instrumental,
      output_format: "url",
      audio_setting: {
        sample_rate: numberArg(args, "sample_rate", { integer: true, choices: [16000, 24000, 32000, 44100], fallback: 44100 }),
        bitrate: numberArg(args, "bitrate", { integer: true, choices: [32000, 64000, 128000, 256000], fallback: 256000 }),
        format: enumArg(args, "format", ["mp3", "wav", "pcm"], "mp3"),
      },
    };
    if (audioUrl) body.audio_url = httpsUrl(audioUrl, "audio_url");
    if (coverFeatureId) body.cover_feature_id = coverFeatureId;
    return await apiRequest("/v1/music_generation", { body, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  if (name === "minimax_preprocess_music_cover") {
    only(args, ["audio_url", "confirm_usage"]); confirmed(args);
    const body = {
      model: "music-cover",
      audio_url: httpsUrl(stringArg(args, "audio_url", { required: true, min: 1, max: MAX_REMOTE_URL_CHARS }), "audio_url"),
    };
    return await apiRequest("/v1/music_cover_preprocess", { body, keyKind: "eligible", env, fetchImpl, apiHostOverride });
  }
  throw new ToolInputError("unknown tool: " + name);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMessage(message, options = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  if (message.method?.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    return jsonRpcResult(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (message.method === "ping") return jsonRpcResult(message.id, {});
  if (message.method === "tools/list") return jsonRpcResult(message.id, { tools: TOOL_DEFINITIONS });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !TOOLS.has(name)) {
      return jsonRpcError(message.id, -32602, "Unknown tool: " + String(name));
    }
    try {
      const result = await executeTool(name, message.params?.arguments || {}, options);
      const warning = name.startsWith("minimax_generate_music") || name.startsWith("minimax_generate_lyrics") || name === "minimax_preprocess_music_cover"
        ? LEGACY_MUSIC_WARNING
        : null;
      return jsonRpcResult(message.id, success(name, result, warning));
    } catch (error) {
      return jsonRpcResult(message.id, failure(name, error));
    }
  }
  return jsonRpcError(message.id, -32601, "Method not found");
}

export function startServer({ input = process.stdin, output = process.stdout, env = process.env, fetchImpl = fetch, apiHostOverride = null } = {}) {
  input.setEncoding("utf8");
  const write = (message) => output.write(JSON.stringify(message) + "\n");
  let buffer = "";
  let stopped = false;
  let chain = Promise.resolve();
  const processLine = async (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length > MAX_LINE_CHARS) {
      write(jsonRpcError(null, -32700, "JSON-RPC line exceeds the 1,000,000 character limit"));
      stopped = true;
      input.destroy?.();
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    const response = await handleMessage(message, { env, fetchImpl, apiHostOverride });
    if (response !== null && message.id !== undefined) write(response);
  };
  const enqueue = (line) => {
    chain = chain.then(() => processLine(line));
    chain.catch((error) => {
      process.stderr.write("minimax_token_plan_mcp fatal: " + String(error?.message || error) + "\n");
      process.exitCode = 1;
      stopped = true;
      input.destroy?.();
    });
  };
  input.on("data", (chunk) => {
    if (stopped) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > MAX_LINE_CHARS) {
        write(jsonRpcError(null, -32700, "JSON-RPC line exceeds the 1,000,000 character limit"));
        stopped = true;
        input.destroy?.();
        return;
      }
      enqueue(line);
    }
    if (buffer.length > MAX_LINE_CHARS) {
      write(jsonRpcError(null, -32700, "JSON-RPC line exceeds the 1,000,000 character limit"));
      stopped = true;
      input.destroy?.();
    }
  });
  input.on("end", () => {
    if (!stopped && buffer) enqueue(buffer);
    buffer = "";
  });
  input.on("error", (error) => {
    process.stderr.write("minimax_token_plan_mcp fatal: " + String(error?.message || error) + "\n");
    process.exitCode = 1;
  });
  return { get done() { return chain; } };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) startServer();

export { TOOL_DEFINITIONS, LEGACY_MUSIC_WARNING };
