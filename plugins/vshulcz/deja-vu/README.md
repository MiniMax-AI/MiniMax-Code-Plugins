# deja-vu

Search over the session history that MiniMax Code and other coding agents already keep on this
machine. The agent can look up what was decided, tried or fixed in earlier sessions, including
sessions from before the plugin was installed and sessions from other agents (Claude Code, Codex,
Cursor, opencode and about forty more).

## The problem

Each new session starts without the previous ones. The answer to "didn't we fix this already?"
is usually sitting in `~/.minimax/v2/sessions` or another agent's transcript folder, but the agent
cannot see it.

## What this Plugin does

It registers the `deja` stdio MCP server (`deja mcp`) and one Skill, `deja-history`, that tells
the agent when to search. The server exposes one `deja` tool with modes such as `recall` (search),
`context` (digest of one past session), `blame` (past sessions that touched a file), `fix` (what
was run after the same error before) and `remember` (store a decision).

## Try it

```text
What did we decide about the retry logic in this repo last week?
```

Expected result: the agent calls `deja` with mode `recall`, gets the matching past sessions with
dates and session ids, and answers from them, naming the session it used.

```text
This test fails with "connection reset by peer". Have we seen it before?
```

Expected result: the agent calls `deja` with mode `fix` and the error text, and lists the
commands that followed the same error in earlier sessions where it did not come back.

## Requirements

- The `deja` CLI on PATH, version 0.23 or newer. This Plugin does not install it. Any of:
  - `npm install -g @vshulcz/deja-vu`
  - `brew install deja-vu`
  - `go install github.com/vshulcz/deja-vu/cmd/deja@latest`
  - the install script or release archives from https://github.com/vshulcz/deja-vu
- `sqlite3` on PATH to read MiniMax Code's workspace database. Transcripts are read without it.
- macOS, Linux or Windows. No account, no API key, no paid service.

Optional: `deja install mcode-auto` adds hooks that bring related history into a session at
start and on each prompt, without the agent having to ask. That step is outside this Plugin.

## Network and data

- Reads the local session stores of coding agents installed on this machine, for MiniMax Code
  `~/.minimax/v2/sessions` and `~/.minimax/v2/sqlite/runtime-state.sqlite`.
- Writes its index to `~/.cache/deja` and notes stored with `remember` to `~/.local/share/deja`
  (the XDG locations when set).
- Credentials found in transcripts (provider keys, tokens, JWTs, PEM blocks, passwords in URLs)
  are replaced with `[redacted:<kind>]` while the index is built.
- Indexing and search are local and send no telemetry. No LLM is involved. The only way a query
  leaves the machine is if you configure `deja embed` against an embedding endpoint of your own.

To remove everything: `rm -rf ~/.cache/deja ~/.local/share/deja ~/.config/deja`.

## Source and license

https://github.com/vshulcz/deja-vu, MIT. Format notes for MiniMax Code's session store:
https://github.com/vshulcz/deja-vu/blob/main/docs/registry/mcode.md
