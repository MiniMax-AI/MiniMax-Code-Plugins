#!/usr/bin/env node

import { open, writeFile } from "node:fs/promises";

const MAX_CONFIG_BYTES = 1_000_000;

async function readBounded(file) {
  const handle = await open(file, "r");
  try {
    const chunks = [];
    let length = 0;
    while (length <= MAX_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_CONFIG_BYTES + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) {
      throw new Error("backend configuration exceeds the 1000000-byte limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally {
    await handle.close();
  }
}

const file = process.argv[2];
if (typeof file !== "string" || !file) {
  process.stderr.write("backend configuration path is missing\n");
  process.exitCode = 1;
} else {
  try {
    if (process.env.NODE_ENV === "test" &&
        process.env.CLI_AGENT_BRIDGE_TEST_BACKEND_CONFIG_READ_STALL_FILE) {
      await writeFile(
        process.env.CLI_AGENT_BRIDGE_TEST_BACKEND_CONFIG_READ_STALL_FILE, "started\n",
      );
      await new Promise(() => { setInterval(() => {}, 1_000); });
    }
    process.stdout.write(await readBounded(file));
  } catch (error) {
    process.stderr.write(String(error?.message ?? error) + "\n");
    process.exitCode = 1;
  }
}
