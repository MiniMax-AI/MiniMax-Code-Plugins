import assert from "node:assert/strict";
import test from "node:test";

import { TOOL_DEFINITIONS, handleMessage } from "../server.mjs";

test("tool failures conform to each declared output schema", async () => {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === "minimax_generate_image");
  assert.ok(tool);

  const response = await handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "minimax_generate_image",
      arguments: { prompt: "fixture without confirmation" },
    },
  });

  assert.equal(response.result.isError, true);
  const structured = response.result.structuredContent;
  assert.equal(structured.ok, false);
  assert.equal(structured.tool, "minimax_generate_image");
  assert.equal(structured.warning, null);
  assert.equal(structured.result.error.type, "invalid_arguments");
  assert.match(structured.result.error.message, /confirm_usage must be true/u);

  for (const required of tool.outputSchema.required) {
    assert.equal(Object.hasOwn(structured, required), true, `missing required key: ${required}`);
  }
  for (const key of Object.keys(structured)) {
    assert.equal(Object.hasOwn(tool.outputSchema.properties, key), true, `unexpected key: ${key}`);
  }
});
