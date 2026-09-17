# Contributing

One folder is one Plugin. One pull request is one contribution.

## 1. Create your Plugin

Fork this repository, install dependencies, and run:

```bash
npm install
npm run create -- <github-owner>/<plugin-name>
```

The command creates `plugins/<github-owner>/<plugin-name>` with a portable `plugin.json`, README,
Apache-2.0 license, and starter Skill.

## 2. Make it real

Replace every scaffold `TODO`. Your Plugin must:

- expose at least one Skill or MCP server;
- use the supported package shape in [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md);
- include `README.md`, `LICENSE`, and a matching open-source license in `plugin.json`;
- explain the user problem, an example prompt, and the expected result;
- disclose required executables, accounts, paid services, platforms, network destinations, and data;
- contain no credentials, private endpoints, hidden telemetry, installers, native binaries, or symlinks.

Keep source and docs inside your Plugin directory. Do not edit another contributor's Plugin in the
same pull request.

### Choose a runtime layout

`docs/plugin-compatibility.md` describes two layouts. Pick one before you write `plugin.json`:

- The **portable Agent Plugins 1.0** layout (top-level `plugin.json`, optional
  `io.minimax.mcode/hooks/hooks.json` for Hooks) is the cross-runtime baseline. Use it when
  your Plugin must run on both mcode 0.3.x and mcode 0.4.0+. The validator
  (`scripts/validate.mjs`) checks this layout by default.
- The **v0.4.0+ plugin format** (`.claude-plugin/plugin.json` with inline `hooks`) is the
  preferred form for Plugins that target mcode 0.4.0+ only. The full schema and the inline
  `hooks` shape are in [`proposals/hooks-v0.4-spec.md`](proposals/hooks-v0.4-spec.md); a
  working example is in [`examples/hello-mcode-hooks-v04/`](examples/hello-mcode-hooks-v04/).

A Plugin that needs both runtimes ships both layouts in parallel. The v0.3.x layout does
not need to duplicate the v0.4.0+ Skill; the recommended cross-runtime shape ships
`skills/SKILL.md` (used by mcode 0.4.0+) and `skills/<plugin-name>/SKILL.md` (a byte-identical
copy under a subdirectory whose name matches the Plugin's `name`, used by the v0.3.x
runtime and the current validator).

## 3. Check it

```bash
npm run check
```

The validator checks the hosted directory, Manifest, Skills, MCP transports, required docs,
placeholders, and path safety. CI runs the same command.

## 4. Open the pull request

Include:

- the problem your Plugin solves;
- a copyable example prompt;
- the expected result;
- dependencies and supported platforms;
- network and data behavior;
- automated and manual test evidence.

Review covers usefulness, reproducibility, clear ownership, data flow, dependency risk, and obvious
supply-chain issues. Acceptance means “available as community software”; it is not a MiniMax
endorsement or a complete security audit.

## Update or remove a Plugin

The owner directory identifies the maintainer. Submit changes under the same path and explain user
impact. A Plugin may be quarantined or removed if it becomes malicious, abandoned, misleading, or
unsafe.

## Improve the platform

Validator, documentation, example, and workflow changes are welcome. Open an issue before a
contract-breaking change, add focused tests, and describe migration impact.

Repository contributions are licensed under Apache-2.0. Each hosted Plugin carries its own license.
