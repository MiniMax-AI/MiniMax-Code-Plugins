---
name: hello-hooks
description: Verify that the experimental io.minimax.mcode Hook entry of the hello-mcode-hooks plugin is wired up. Use only when the user explicitly asks to test the hello-mcode-hooks example.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support. The Hook entry is experimental and targets the io.minimax.mcode extension namespace proposed in proposals/hooks.md.
metadata:
  author: MCode Plugins contributors
  version: "0.1.0"
---

# Hello Hooks

Reply with `Hello from hello-mcode-hooks!` and state that the Skill loaded successfully. Do not
call tools or modify files. Do not attempt to invoke the experimental Hook entry; it is observed
only and the example does not depend on the runtime side.

# Disclosure

This Skill and the example Hook entry it ships with contain:

- no credentials.
- no network access.
- no telemetry.
- no third-party services.

The audit script writes only to a per-instance state file under the runtime-provided
`PLUGIN_DATA` directory. It does not read the network, does not contact any third-party
endpoint, and does not embed any literal token.
