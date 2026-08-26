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

For a Hook-only Plugin, start from [`examples/hello-mcode-hooks`](examples/hello-mcode-hooks/) and
keep the same hosted README, LICENSE, and manifest requirements.

## 2. Make it real

Replace every scaffold `TODO`. Your Plugin must:

- expose at least one Skill, MCP server, or MiniMax Code Hook;
- use the supported package shape in [`docs/plugin-compatibility.md`](docs/plugin-compatibility.md);
- follow the versioned [`Hooks 0.1 contract`](docs/hooks.md) for every Hook;
- include `README.md`, `LICENSE`, and a matching open-source license in `plugin.json`;
- explain the user problem, a copyable prompt or lifecycle reproduction, and the expected result;
- disclose required executables, accounts, paid services, platforms, network destinations, and data;
- for Hooks, disclose every event, command, implicit side effect, received data category, and stored
  data location;
- contain no credentials, private endpoints, hidden telemetry, installers, native binaries, or symlinks.

Keep source and docs inside your Plugin directory. Do not edit another contributor's Plugin in the
same pull request.

## 3. Check it

```bash
npm run check
```

The validator checks the hosted directory, Manifest, Skills, MCP transports, Hooks, required docs,
placeholders, and path safety. CI parses Hook configuration and source as data and never executes a
contributed Hook command.

## 4. Open the pull request

Include:

- the problem your Plugin solves;
- a copyable example prompt or lifecycle reproduction;
- the expected result;
- dependencies and supported platforms;
- network and data behavior;
- automated and manual test evidence.

Review covers usefulness, reproducibility, clear ownership, implicit execution, data flow,
dependency risk, and obvious supply-chain issues. Acceptance means “available as community
software”; it is not a MiniMax endorsement or a complete security audit. Hook acceptance confirms
the staged registry declaration only. It does not establish runtime availability until this
repository links a compatible MiniMax Code implementation and end-to-end conformance evidence.

## Update or remove a Plugin

The owner directory identifies the maintainer. Submit changes under the same path and explain user
impact. A Plugin may be quarantined or removed if it becomes malicious, abandoned, misleading, or
unsafe.

## Improve the platform

Validator, documentation, example, and workflow changes are welcome. Open an issue before a
contract-breaking change, add focused tests, and describe migration impact.

Repository contributions are licensed under Apache-2.0. Each hosted Plugin carries its own license.
