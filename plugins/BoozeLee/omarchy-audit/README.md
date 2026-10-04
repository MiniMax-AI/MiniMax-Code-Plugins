# omarchy-audit

Static security triage for an [Omarchy](https://github.com/omacom/omarchy) checkout, built for
the [Omarchy Bug Bounty](https://hackerone.com/omarchy) on HackerOne.

It answers three questions that a plain `shellcheck bin/*` gets wrong, and it will not run
anything it finds.

## Try it

```text
Audit ~/research/omarchy for command-injection siblings that are not already patched.
```

Expected result: a findings table of `component | file:line | rule | severity | status`, where
every row is tagged `new`, `already-fixed-pattern`, or `false-positive` with a one-line
reason, and the already-patched files are excluded up front.

## Why it exists

**A `*.sh` sweep finds nothing.** Omarchy's `bin/` ships 444 scripts and **none** end in
`.sh` — they are all extensionless. The 464 files that do end in `.sh` live in `test/`,
`migrations/`, and `install/`. So `find bin -name '*.sh'` returns zero and a hunt built on it
never looks at a single shipped command. This Plugin discovers scripts by **shebang**, and
finds all 444.

**Half the fix history is missing from most summaries.** Omarchy shipped 27 security fixes
across v4.0.1, v4.0.2, and v4.0.3. Summaries usually list 8, which is how an entire family
gets re-reported. The embedded map records all of them with the *remedy* used, so a sibling
that lacks the remedy is distinguishable from the fix itself.

**"Root-reachable" is not "runs as root".** Grepping `bin/` for scripts without
`export PATH=` returns ~67 hits. Every one is a false positive: they run as the user and call
`sudo`, so sudo's own `secure_path` governs the child. The set of scripts actually *invoked as
root* is small, and it lives in `etc/sudoers.d/`. The Skill says so, and says to enumerate
that first.

## Try it without mcode

The server is plain Node over stdio with no dependencies:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discover_scripts","arguments":{"root":"/path/to/omarchy"}}}' \
  | node server.mjs
```

## Tools

| Tool | Does |
|---|---|
| `discover_scripts(root, includeSkipped?)` | every shell script, by shebang, with its top-level directory as `kind` |
| `shellcheck_run(root, severity?)` | batched shellcheck; every finding tagged `already-fixed-pattern` or `new` |
| `classify(file, line?)` | tag one location against the embedded fix map |
| `findings_table(findings)` | format as `component \| file:line \| rule \| severity \| status` |
| `known_fixed()` | the v4.0.1–v4.0.3 fix map: file, PR, family, remedy |

`test/`, `tests/`, and `vendor/` are skipped by default — 278 of the tree's `.sh` files are
test fixtures and would otherwise dominate every table.

## Requirements

- MiniMax Code 0.3 or newer (for the Skill), or Node 18+ (to run `server.mjs` directly).
- `shellcheck` on `PATH` for `shellcheck_run`. Without it that one tool returns a note and
  the rest keep working; discovery and classification have no dependencies.
- An Omarchy checkout. Audit the **tag users run** — the default branch is `quattro` at
  `4.0.0.alpha`, not the release.

## Data and network

- **Network access: none.** The fix map is embedded, not fetched. A sweep works fully
  offline and this Plugin never contacts a registry, an API, or a package index.
- **Credentials: none.** It reads no environment secrets and writes no configuration.
- **Data handled:** the target tree, read-only. It reads script files to detect shebangs and
  to hand them to shellcheck. It writes nothing to the target, and never follows a symlink
  out of it.
- **Never executes target code.** `shellcheck` parses; it does not run. This is covered by a
  regression test that plants a script which would create a marker file and asserts the
  marker never appears.
- **Never submits anything.** The tool emits a table. Reporting is the human's decision, made
  on HackerOne or via `security@omarchy.org`.

## Install

```bash
cp -r omarchy-audit ~/.minimax/plugins/
mcode plugin add omarchy-audit@local
mcode plugin list -m local
```

The Plugin root must be a **physical directory** — MiniMax Code opens plugin roots with
`rejectSymlink: true` and drops a symlinked one with `PLUGIN_ROOT_SYMLINK`, without a visible
error. `cp -r`, not `ln -s`.

## License

MIT — see [LICENSE](LICENSE).
