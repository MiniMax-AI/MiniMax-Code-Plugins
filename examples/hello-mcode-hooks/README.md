# Hello MiniMax Code Hooks

This Hook-only example records `pre-tool-use` and `post-tool-use` event names in
`${PLUGIN_DATA}/events/`. It consumes but never stores the client-native event payload and retains
at most 128 atomic JSON records, pruning the oldest records after concurrent invocations.

## Requirements

- a MiniMax Code build that advertises the MiniMax Code Hooks 0.1 schema;
- Node.js 22 or newer on `PATH`; and
- user or organization approval to execute the bundled Hook script.

It requires no account or paid service, makes no network requests, and stores only an event name and
timestamp in the Plugin's isolated data directory.

This repository does not yet link a MiniMax Code runtime build and end-to-end fixture certified for
Hooks 0.1. The package is therefore a declaration and validation example, not evidence that a
currently released client will execute it.

## Try it

After installing the Plugin into a compatible MiniMax Code build, ask:

```text
List the files in this workspace.
```

Expected result: MiniMax Code performs its normal tool work, while the Hook appends bounded event
records to `${PLUGIN_DATA}/events/`. The Hook cannot block or modify the tool call.

Run `npm run check` from the repository root. Static Plugin validation does not execute Hook
commands; the test suite separately executes this repository-owned example with a minimal
environment to verify bounded concurrent writes.
