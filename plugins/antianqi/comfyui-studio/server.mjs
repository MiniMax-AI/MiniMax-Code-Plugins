// ComfyUI Studio — dependency-free stdio MCP server
//
// Exposes three tools for driving a local ComfyUI 8188 server:
//   - submit_prompt  Submit a workflow JSON, return the prompt_id
//   - check_queue    Inspect running / pending queue
//   - get_image      Download a generated image by filename
//
// Configuration via environment variables:
//   COMFYUI_URL       ComfyUI base URL (default http://127.0.0.1:8188)
//   COMFYUI_API_TOKEN Optional bearer token if ComfyUI is fronted by an auth proxy
//
// This server intentionally has zero npm dependencies. The MCP wire
// protocol is plain JSON-RPC over stdio, so we speak it directly with
// line-delimited JSON messages.

import { createInterface } from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const COMFYUI_URL = (process.env.COMFYUI_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const COMFYUI_API_TOKEN = process.env.COMFYUI_API_TOKEN || "";

const TOOLS = [
  {
    name: "submit_prompt",
    description:
      "Submit a ComfyUI workflow JSON to the local server and return the prompt_id for later polling.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: {
          type: "object",
          description: "ComfyUI workflow JSON (the value to put under the `prompt` key).",
        },
      },
      required: ["workflow"],
      additionalProperties: false,
    },
  },
  {
    name: "check_queue",
    description:
      "Return the current ComfyUI queue: counts of running and pending prompts and their prompt_ids.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_image",
    description:
      "Download a generated image from ComfyUI's /view endpoint by filename and subfolder. Returns the image bytes as a base64 string plus the content type.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Image filename on the ComfyUI server." },
        subfolder: { type: "string", description: "Optional subfolder under the output directory." },
        folder_type: {
          type: "string",
          enum: ["output", "input", "temp"],
          description: "ComfyUI folder type. Default: output.",
        },
      },
      required: ["filename"],
      additionalProperties: false,
    },
  },
];

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(COMFYUI_URL + path);
    const lib = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(
      {
        method,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(COMFYUI_API_TOKEN ? { authorization: `Bearer ${COMFYUI_API_TOKEN}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, text });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function callSubmitPrompt({ workflow }) {
  const { status, text } = await httpJson("POST", "/prompt", { prompt: workflow });
  if (status >= 400) {
    return { content: [{ type: "text", text: `ComfyUI error ${status}: ${text}` }], isError: true };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { content: [{ type: "text", text: `Non-JSON response: ${text}` }], isError: true };
  }
  if (data.error) {
    return {
      content: [{ type: "text", text: `Workflow rejected: ${JSON.stringify(data.error)}` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ prompt_id: data.prompt_id, number: data.number }, null, 2),
      },
    ],
  };
}

async function callCheckQueue() {
  const { status, text } = await httpJson("GET", "/queue");
  if (status >= 400) {
    return { content: [{ type: "text", text: `ComfyUI error ${status}: ${text}` }], isError: true };
  }
  const data = JSON.parse(text);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            running: (data.queue_running || []).length,
            pending: (data.queue_pending || []).length,
            running_ids: (data.queue_running || []).map((q) => q[1]),
            pending_ids: (data.queue_pending || []).map((q) => q[1]),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function callGetImage({ filename, subfolder = "", folder_type = "output" }) {
  const params = new URLSearchParams({ filename, subfolder, type: folder_type });
  const { status, text } = await httpJson("GET", `/view?${params.toString()}`);
  if (status >= 400) {
    return { content: [{ type: "text", text: `ComfyUI error ${status}: ${text}` }], isError: true };
  }
  // We cannot send raw binary in a stdio JSON-RPC response, so we return the
  // bytes as base64 alongside the inferred content type.
  const buf = Buffer.from(text, "binary");
  const contentType = filename.toLowerCase().endsWith(".png") ? "image/png" : "image/octet-stream";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { filename, content_type: contentType, size_bytes: buf.length, base64: buf.toString("base64") },
          null,
          2
        ),
      },
    ],
  };
}

const HANDLERS = {
  submit_prompt: callSubmitPrompt,
  check_queue: callCheckQueue,
  get_image: callGetImage,
};

function send(obj) {
  stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args) {
  stderr.write("[comfyui-studio] " + args.join(" ") + "\n");
}

const rl = createInterface({ input: stdin, terminal: false });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    log("discarding non-JSON line");
    return;
  }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "comfyui-studio", version: "0.1.0" },
          capabilities: { tools: {} },
        },
      });
    } else if (method === "notifications/initialized") {
      // no-op
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      const handler = HANDLERS[name];
      if (!handler) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
        return;
      }
      const result = await handler(args || {});
      send({ jsonrpc: "2.0", id, result });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    log("handler error:", err && err.stack ? err.stack : String(err));
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err && err.message || err) } });
  }
});

log("ready; talking to", COMFYUI_URL);
