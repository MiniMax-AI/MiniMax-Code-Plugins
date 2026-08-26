# Security model

Hosted Plugins use three layers of evidence:

1. **Package validation** checks the owner/name layout, Manifest, Skill, MCP, and Hooks contracts,
   required documentation, unfinished placeholders, and symlinks without executing Plugin code.
2. **Pull request evidence** makes every source change reviewable before it reaches `main`.
3. **Human review** evaluates usefulness, dependencies, data flow, suspicious code, maintenance
   ownership, and reproducible test evidence.

These checks reduce ambiguity but are not a sandbox or full audit. `stdio` MCP servers execute local
programs with the user's permissions. Remote MCP servers send data to configured destinations.
Skills can instruct an agent to use tools and change files. Hooks can execute local commands
implicitly at lifecycle points and may receive prompt or tool data, so they remain disabled until a
compatible client obtains user or organization authorization.

Hook authors must disclose every event, executable, platform requirement, file write, network
destination, and data category the Hook can receive or persist. Hooks 0.1 is observe-only: output,
failure, or timeout cannot approve, deny, rewrite, or otherwise change agent behavior. Clients must
sanitize ambient environment values, isolate `PLUGIN_DATA`, bound process resources and diagnostics,
and provide global and per-Plugin disable controls.

Static registry validation parses Hooks as data and never executes commands from hosted
contributions under `plugins/`. Repository tests may execute explicitly reviewed, repository-owned
example fixtures with a minimal environment. Adding a Hook, changing its executable, or expanding
its data access is a capability change that runtime clients should present for authorization again.

Never commit credentials, private endpoints, or personal data. Use runtime-supported secret and
environment mechanisms. Maintainers may quarantine or remove a Plugin while a security report is
investigated.
