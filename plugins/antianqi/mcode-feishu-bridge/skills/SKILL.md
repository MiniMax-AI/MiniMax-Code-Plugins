---
name: mcode-feishu-bridge
description: Drive MiniMax Code remotely from a Lark/Feishu conversation, so the user can send a task from their phone and get the result back in the same message. Use when the user wants to control mcode from Feishu or Lark, asks to set up, start, stop, inspect or troubleshoot a Feishu-driven mcode bridge, wants to know whether the bridge is running, or reports that a Feishu message got no reply. Requires the lark-cli and mcode CLIs; ships no credentials.
---

# mcode-feishu-bridge

Runs a small polling daemon that turns a Lark/Feishu message into a local `mcode`
turn and writes the answer back into that same message.

## What the user gets

One Feishu message per task, updated in place:

1. a placeholder appears within a poll interval,
2. it flips to `⚙️ calling \`write\`…` while tools run,
3. it ends as the final answer plus a `⏱ 12.3s · 1335 tokens · 2 tool calls` footer.

Because every intermediate state is an edit of the same message, a task that makes
twelve tool calls still produces one bubble, not twelve.

## Before starting anything

> **Do not confuse this with the built-in `lark-tools` Skill.** `lark-tools` drives
> Feishu *from* mcode — documents, calendar, Base, mail, approvals. This Plugin is
> the opposite direction: a Feishu message becomes a local `mcode` turn. The
> desktop runtime also has a Feishu channel, which is the same reverse direction but
> needs the Mavis desktop app running and a Feishu app bound to it. Never present
> this Plugin as a replacement for `lark-tools`; they do different jobs and can run
> side by side.

The bridge has **no credentials of its own**. It uses `lark-cli`, which must already
be configured for the user. Check first:

```bash
lark-cli auth status
```

Two things must both be true, and they are the two that actually go wrong:

- `identities.bot.status` is `ready` — the bridge **reads with the user identity but
  writes with the bot identity**, because only a bot may edit a message it sent, and
  a bot cannot see a p2p conversation's history.
- `identities.user.status` is `ready` and the token is `valid`.

The app needs at least `im:message:readonly` and `im:resource` for the user side, and
`im:message` plus `im:message:update` for the bot side. `offline_access` matters most
in practice: without it the user token stops working after a couple of hours and the
bridge goes quiet with no error at the time it happens.

If `lark-cli` is not signed in, do not attempt to sign in for the user. Tell them to
run `lark-cli config init` and `lark-cli auth login` themselves, and stop there.

`mcode` must be installed and runnable. The bridge discovers both CLIs from `PATH`
and the install layout; it never hardcodes a path.

## Configuration

There is deliberately **no default chat id**. A chat id is a private identifier, so
the user has to supply one. The bridge accepts it three ways, in priority order:

```bash
# 1. flag
node scripts/mcode-feishu-bridge.mjs --watch --chat oc_xxxxxxxxxxxxxxxx

# 2. environment
MCODE_FEISHU_CHAT=oc_xxxxxxxxxxxxxxxx node scripts/mcode-feishu-bridge.mjs --watch

# 3. config file in the data directory
#    <data-dir>/config.json  ->  { "chatId": "oc_xxxxxxxxxxxxxxxx" }
```

The data directory is `$PLUGIN_DATA` when the runtime provides it, otherwise
`$MCODE_FEISHU_BRIDGE_DATA`, otherwise `~/.mcode-feishu-bridge`.

## Operating the bridge

```bash
# one pass, then exit — use this to check on a single message
node scripts/mcode-feishu-bridge.mjs --chat <chatId>

# long-running watcher
node scripts/mcode-feishu-bridge.mjs --watch --interval 2000 --chat <chatId>

# stop the running watcher (kills the mcode process tree too)
node scripts/mcode-feishu-bridge.mjs --stop
```

Only `--watch` takes the single-instance lock, so one-shot runs never block each
other. If a second watcher is refused with exit code 3, the first one is healthy;
use `--stop` rather than deleting the lock file.

Useful flags:

| flag | default | meaning |
|---|---|---|
| `--chat <id>` | none | conversation to watch |
| `--watch` | off | keep polling instead of one pass |
| `--interval <ms>` | 3000 | poll interval |
| `--timeout <ms>` | 600000 | hard ceiling on one mcode turn |
| `--log <path>` | `<data-dir>/bridge.log` in watch mode | also append output to a file |
| `--stop` | — | stop the running watcher |

## Behaviour worth knowing before you debug it

- **The bridge answers only what mcode can do.** It never fabricates a result. If
  mcode fails, the failure text is what the user sees.
- **mcode runs with `--permission full`.** This is deliberate: a phone is a bad
  place to answer approval prompts. Tell the user this plainly, because a
  Feishu message can therefore cause arbitrary local changes. Suggest pinning the
  bridge to a dedicated workspace directory if that trade is not acceptable.
- **One turn at a time per chat.** A second message is processed after the first
  finishes, not concurrently.
- **A hung mcode is killed, not waited on.** After `--timeout` the process tree is
  terminated and the chat gets an explicit timeout notice naming how many tool
  calls had already run.

## If the user says a message got no reply

Work through this order; the first four are the ones that actually happen.

1. **Read the log.** The bridge logs to `<data-dir>/bridge.log` and the file is
   readable while it runs. An empty log plus a silent chat means the watcher is not
   running at all — start it.
   - No `✓` line for that message means it was never picked up.
   - `✗ fetch messages failed` means the **user** identity failed. Usually an expired
     token, or `offline_access` was never granted. Have the user re-run
     `lark-cli auth login`.
   - The answer is a failure notice even though the message was picked up: the **bot**
     identity cannot send, so even the fallback reply failed.
   - `✗ the watermark is not on this page` means the bridge fell too far behind; it
     escalates to full pagination on its own, so this line means that also failed.
2. **Check both identities.** `lark-cli auth status`. `identities.user` covers
   reading and attachments; `identities.bot` covers sending, replying and editing.
   They fail independently and the symptoms differ.
3. **Check the process and the lock.** `bridge.lock` in the data directory holds a
   pid. A lock whose pid no longer exists is stale and is reclaimed automatically.
4. **Check the watermark.** `state.json` records the last processed message per
   chat. If it is ahead of the user's message, the message was already handled.
5. **Run the tests.** `node scripts/mcode-feishu-bridge.test.mjs` is self-contained
   and prints a pass/fail summary. It is the fastest way to tell whether the host
   is broken or the conversation simply outgrew one page.

`README.md` has a symptom-to-cause table covering the permission and identity
failures, which are the ones users cannot diagnose from the log alone.

## Tests

```bash
node scripts/mcode-feishu-bridge.test.mjs
```

84 assertions covering edit ordering, delivery backoff and give-up, the mcode hard
timeout, the single-instance lock, message paging, and a static check that the
source never routes a child process through a shell. The suite imports the real
module rather than a copy, so a green run says something about the shipped code.

Two cases (`O` and `V`) read this plugin's own source. If you add a spawn call,
keep `shell: false`; case `O` fails otherwise.

## Running it unattended

The Plugin ships no autostart mechanism, deliberately. If the user wants it always
on, put it under a supervisor they already run, and warn them about one specific
trap: **do not start a long-lived child with std handles inherited from a parent that
waits on the pipe.** The caller blocks until the child closes it, which is forever.
Start it detached, or let the bridge write its own log with `--log`.

## Network destinations

- `open.feishu.cn` / `open.larksuite.com`, through `lark-cli`, for message read,
  message send, message edit, and attachment download. Required.
- The Feishu Open Platform host, through `lark-cli`, for token refresh. Required.

No other destination is contacted. See `README.md` for the full data-flow
disclosure.
