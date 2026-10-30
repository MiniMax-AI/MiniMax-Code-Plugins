# Glasser research Skill for MiniMax Code

A CLI-oriented community adaptation of the official [Glasser plugin](https://github.com/glasser-ai/plugins), prepared by Xinwei Liao (Glasser GTM Team). This package is maintained under Coding-jpg; it is not a MiniMax endorsement. Upstream copyright and MIT license are retained in LICENSE.

## User problem

Research agents need to find a suitable paid data endpoint, understand its input contract and current cost, and keep execution within the user's approved scope. This Skill documents that workflow using the official Glasser CLI.

## Example prompt and expected result

> Find a suitable Glasser endpoint for competitor keyword research for the domain and market I provide. Show me its schema and current price. Do not execute any paid request until I approve it.

Expected result: candidate endpoints, one inspected contract, and a proposed small request with pricing. The Skill itself does not perform a paid call or fabricate research results.

## Installation and dependencies

For MiniMax Code 0.7.2, copy this directory to `<MiniMax data directory>/plugins/glasser`, then run `mcode plugin list --marketplace local --available --json` to verify discovery. The data directory can be set with `MINIMAX_DATA_DIR`; keep validation separate from an existing installation. The package includes the portable Agent Plugins 1.0 manifest and the MiniMax Code 0.4+ manifest, with byte-identical copies of one Skill. It has no hooks, custom agents, commands or bundled MCP servers.

The host needs a shell and an already installed official Glasser CLI (`@glasser-ai/cli`), Node.js 22+, internet access, and an authenticated Glasser account/Workspace. Refer to the [official upstream setup instructions](https://github.com/glasser-ai/plugins) for CLI installation and login. The package does not install executables. Host/client and CLI platform support apply; no claim of testing every OS is made.

## Accounts and paid services

A Glasser account and Workspace are required for authenticated use. Data requests are pay-as-you-go. Inspect the endpoint's current price and charge clauses before requesting user approval. The MIT license applies to these instructions, not to hosted data services. MiniMax account or model charges are separate.

## Network and data behavior

This package makes no network requests on load. When the user invokes the installed CLI, it contacts Glasser's documented API and authentication endpoints, including `https://api.glasser.ai` and `https://app.glasser.ai`. Requests may be routed to the selected third-party data provider. The host client may process prompts and returned results. No credentials, private endpoints, telemetry, installers, binaries or symlinks are included.

## Documentation, privacy and support

- Product documentation: https://glasser.ai/docs
- Official source: https://github.com/glasser-ai/plugins
- Example workflow: https://glasser.ai/tutorial/analyze-competitor-keywords
- Support: support@glasser.ai
- Privacy policy: https://glasser.ai/privacy-policy
- Service terms: https://glasser.ai/terms-of-service

## Validation scope

Validated on macOS with MiniMax Code 0.7.2 using an isolated local data directory: the CLI reports `glasser@local`, enabled, with one Skill and no MCP server. The repository package validator passes. The full repository suite ran 1,121 tests: 1,118 passed, two unrelated existing-plugin tests failed in this macOS environment, and one was skipped (see the submission report). No model conversation or paid Glasser request was executed; those end-to-end results are not claimed.
