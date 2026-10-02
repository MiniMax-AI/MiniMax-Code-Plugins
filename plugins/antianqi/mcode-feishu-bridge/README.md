# mcode-feishu-bridge

Drive [MiniMax Code](https://github.com/MiniMax-AI/MiniMax-Code) remotely from a
Lark/Feishu conversation. Send a task from your phone, mcode runs it on your machine
with its normal tool access, and the answer comes back **in the same message**.

- **The problem.** MiniMax Code is a terminal application. On a desktop that is
  fine; away from it, the only options are a remote desktop session or a tunnel.
  Neither is pleasant, and neither works from a phone.

- **What this does.** A small polling daemon watches one Feishu conversation. Each
  new message becomes one `mcode exec` turn in a workspace directory that belongs to
  that conversation. The answer is written back into the same message by editing it,
  so a task that makes twelve tool calls still produces one chat bubble.

## Example

**Prompt** (sent in the Feishu conversation):

> create a file notes.md in the current directory with the content "shopping list",
> then read it back to confirm

**Result** — the bot's reply in the chat, edited in place:

> 🧠 received, thinking…
>
> ⚙️ calling `write`…
>
> Created and read back successfully.
>
> `…\workspaces\oc_xxxxxx\notes.md` — 16 bytes, content:
>
> ```
> shopping list
> ```
>
> `shopping list` = 13 characters + newline = 14 bytes, consistent with the byte count
> and the content read back matches character for character.
>
> ---
> ⏱ 11.4s · 2 tool calls

The intermediate states and the final answer are the same Feishu message, so the
conversation stays readable and nothing is duplicated.

## What you get

- **One message per task.** The placeholder, every tool call, and the final answer
  are the same Feishu message, edited in place. A turn that runs twelve tools
  produces one bubble.
- **Live progress.** The message flips to `⚙️ calling \`write\`…` while a tool runs,
  so a two-minute task does not look like a hang.
- **Real tool access.** mcode runs with its normal tools in a per-conversation
  workspace, so the bridge can create files, run commands, and read results.
- **Continuous context.** The conversation keeps one mcode session, so "and now
  read it back" works. Each conversation gets its own session, so two do not bleed
  into each other.
- **Attachments.** Images and files you send are downloaded into the conversation's
  workspace and passed to mcode.
- **A hung turn is killed, not waited on.** After a configurable ceiling the process
  tree is terminated and the chat gets an explicit notice naming how many tool calls
  had already run.
- **A footer on every answer** — elapsed time, token count, tool-call count.
- **Delivery that does not lose your result.** If the edit fails, the answer is sent
  as a reply instead. If that fails too, it is retried with a linear backoff and
  then given up on loudly, rather than retried forever.
- **One bridge at a time.** A second watcher is refused rather than silently racing
  the first one over the same state.
- **Readable while running.** The log is written by the bridge itself, so you can
  read it without the file being locked.

## How this differs from the built-in Feishu support

MiniMax Code ships Feishu support in two places already, and neither one is this
Plugin. This one sends messages in the opposite direction, against a local mcode
CLI rather than the desktop runtime.

| | direction | what it is for |
|---|---|---|
| `lark-tools` (built-in Skill) | mcode → Feishu | office work: read and write docs, calendar, Base, mail, approvals |
| Feishu channel (local-runtime) | Feishu → agent | driving the Mavis desktop runtime through a bound Feishu app |
| **This Plugin** | **Feishu → mcode** | **driving a local mcode CLI install** |

The first is not a remote control. Ask it to summarise this week's meeting notes
and it does that inside Feishu; it does not run a task on your machine.

The second has the same shape as this Plugin but a different host. It lives in the
Mavis desktop runtime, so it needs the desktop app running and a Feishu app bound
to it, and it answers with interactive cards — including a permission card that
approves a pending tool call by tapping. Prefer it if the desktop app is already
your working environment.

This Plugin covers the remaining case: a headless machine with `mcode` and
`lark-cli` on `PATH` and nothing else. It is a plain polling process, so any
supervisor you already use can restart it, and there is nothing to install. In
exchange it edits plain text messages instead of sending cards, and it runs with
`--permission full` because there is no in-chat approval prompt to tap — see
[Security model](#security-model).

The two do not conflict. Installing this Plugin neither requires nor disables the
built-in channel, and both can run at once.

## Setup

The Plugin is Skill-only: no `mcp.json`, no `package.json`, no install step. But it
does need three things lined up, and two of them are easy to get half-right.

### 1. MiniMax Code

Installed and runnable:

```bash
mcode --version
```

### 2. A Feishu/Lark app, with **two** working identities

This is the part that trips people up. The bridge reads and writes through
**different identities**, and both have to work:

| what | identity | why |
|---|---|---|
| read the conversation, download attachments | **user** | the bot cannot see a p2p conversation's history |
| send, reply, and edit the answer | **bot** | only a bot may edit a message it sent |

```bash
lark-cli auth status
```

Both `identities.bot.status` and `identities.user.status` must read `ready`.
If either is not, fix that before going further — otherwise the bridge reads
nothing or writes nothing, and the log only says `fetch messages failed`.

The app needs at least these scopes, derived from the operations it performs:

| scope | needed for | identity |
|---|---|---|
| `im:message:readonly` | reading messages in the conversation | user |
| `im:resource` | downloading an image or file you send | user |
| `im:message` | sending the placeholder and the answer | bot |
| `im:message:update` | editing that placeholder into the answer | bot |
| `offline_access` | letting the user token refresh instead of expiring | user |

`offline_access` is the one people miss. Without it the user token stops working
after a couple of hours and the bridge goes quiet, with no error at the time it
happens. Note also that the user identity here is **your** account: the bridge acts
as you, with everything that implies.

Publish the app (Feishu requires an app to be published before another user can
talk to it), then open a chat with it. A p2p chat with your own app is the simplest
arrangement and the one this Plugin is built and tested for.

### 3. A chat id

There is deliberately no default: a chat id is a private identifier, so it has to be
yours to supply.

```bash
lark-cli im +chat-list --types=p2p,group --page-all --as user --format json
```

Find your conversation in the output. The `--page-all` matters — without it the
listing silently truncates and you may not see the conversation you are looking for.

### 4. Start it

```bash
node scripts/mcode-feishu-bridge.mjs --watch --chat <your-chat-id>
```

On the first run the bridge creates a workspace for that conversation and picks up
nothing historical: it starts from the newest message at the time it launches. Send
it a message after starting, not before.

Full operating instructions are in
[`skills/mcode-feishu-bridge/SKILL.md`](skills/mcode-feishu-bridge/SKILL.md).

## Usage

```bash
# one pass, then exit — the quickest way to try it
node scripts/mcode-feishu-bridge.mjs --chat <chat-id>

# the long-running watcher
node scripts/mcode-feishu-bridge.mjs --watch --chat <chat-id>

# stop the running watcher; kills any mcode turn with it
node scripts/mcode-feishu-bridge.mjs --stop
```

| flag | default | meaning |
|---|---|---|
| `--chat <id>` | none | conversation to watch; required |
| `--watch` | off | keep polling instead of one pass |
| `--interval <ms>` | 3000 | poll interval |
| `--timeout <ms>` | 600000 | hard ceiling on one mcode turn |
| `--log <path>` | `<data-dir>/bridge.log` in watch mode | also append output to this file |
| `--stop` | — | stop the running watcher |

Only `--watch` takes the single-instance lock, so one-shot runs never block each
other.

The conversation can also be configured once, instead of on every start:

```bash
MCODE_FEISHU_CHAT=oc_xxxxxxxxxxxxxxxx     # environment
# or <data-dir>/config.json  ->  { "chatId": "oc_xxxxxxxxxxxxxxxx" }
```

## What's in the package

```text
mcode-feishu-bridge/
├── plugin.json                     portable Agent Plugins 1.0 manifest
├── .claude-plugin/plugin.json      v0.4.0+ manifest
├── skills/
│   ├── SKILL.md                    v0.4.0+ Skill
│   └── mcode-feishu-bridge/
│       └── SKILL.md                v0.3.x Skill, byte-identical to the above
├── scripts/
│   ├── mcode-feishu-bridge.mjs     the bridge
│   └── mcode-feishu-bridge.test.mjs the suite
├── README.md
└── LICENSE
```

Two Skill copies because the two runtimes discover Skills differently; the
recommended cross-version layout keeps them byte-identical, and this Plugin follows
it. There is no `mcp.json`, no `package.json`, and no bundled binary.

## Running it in the background

The Plugin ships no service manager, on purpose: a login hook that runs a hidden
process forever is exactly the kind of thing that should be a deliberate, visible
choice by the person running the machine, not a default a Plugin installs.

If you do want it always on, run the watcher under whatever supervisor you already
use, and make sure it inherits a real `PATH` so the bridge can find `lark-cli` and
`mcode`:

```bash
nohup node scripts/mcode-feishu-bridge.mjs --watch --chat <chat-id> >> bridge.log 2>&1 &
```

Two rules that follow from how this is built:

- **Do not redirect the watcher's stdout from a supervisor that waits on the
  child's pipe.** A long-lived child spawned with inherited std handles keeps that
  pipe open, and the supervisor blocks forever. Start the watcher with std handles
  closed or detached, or let the bridge write its own log via `--log`.
- **The bridge takes a single-instance lock, so a second copy is refused with exit
  code 3** rather than corrupting state. If that is not what you wanted, find the
  first one: `bridge.lock` in the data directory holds its pid.

## Uninstall

There is nothing to uninstall. To stop it and remove its data:

```bash
node scripts/mcode-feishu-bridge.mjs --stop
```

Then delete the data directory (`$PLUGIN_DATA`, else `~/.mcode-feishu-bridge`).
That removes the per-conversation workspaces and the downloaded media. Removing the
Plugin from MiniMax Code leaves that directory alone, by design — it is the user's
data, and a Plugin should not delete it on uninstall.

## Network

Outbound HTTPS to the Feishu/Lark Open Platform, through `lark-cli`. No inbound
listener, no local port, no other host. If your machine reaches Feishu through a
proxy, `lark-cli` needs it configured; the bridge does not set one.

## How it works

```
Feishu message
   │
   ├─ poll (default every 3s) → +chat-messages-list
   │     newest page first; full pagination only when the watermark fell off the page
   │
   ├─ send a placeholder, then edit it for every state change
   │     edits are queued serially, so a late tool hint can never overwrite the answer
   │
   ├─ mcode exec --cwd <workspace> --session <session> --permission full
   │     stream-json is parsed as it arrives to show tool calls live
   │
   └─ the answer overwrites the placeholder, with a time/token/tool-call footer
```

Each conversation gets its own workspace and its own mcode session, so context is
continuous per chat and isolated between chats.

## What it deliberately does not do

- **No conversation history replay.** The bridge starts from the last message it
  handled. It does not re-run old messages.
- **No concurrency per chat.** The second message waits for the first to finish.
  Two `mcode exec` runs against one session would interleave.
- **No card messages.** Feishu cards need a different update path; this uses plain
  text messages and edits them.
- **No message deletion.** It never recalls anything. Every message the bot sends
  stays until you delete it yourself.

## Security model

**This is the part to read before enabling it.**

- mcode runs with `--permission full`, so it does not stop to ask for approval. A
  Feishu message can therefore cause arbitrary changes to your working directory:
  writing files, running commands, installing things. A phone is a bad place to
  answer approval prompts, so the prompts are removed — but that means the
  guarantee you have to rely on is the Feishu account, not the permission system.
- If that trade is not acceptable for you, point the bridge at a dedicated
  workspace directory, so the blast radius is one directory you can throw away.
  The workspace is created under `<data-dir>/workspaces/<chat-id>/`.
- The account used to read the chat is a **user** token, so the bridge acts as you,
  with everything that implies.

## Disclosures

### No credentials of its own

This Plugin contains no tokens, keys, secrets, cookies, or private endpoints, and it
reads none from the environment to authenticate anything. There is no credential to
leak from the package.

### It depends on a lark-cli configuration you already own

The bridge never signs in. It shells out to `lark-cli`, which you install and
authenticate yourself with `lark-cli config init` and `lark-cli auth login`. Your
`lark-cli` credentials live in your own `lark-cli` config directory and are used by
`lark-cli`, not by this Plugin. If `lark-cli` is not signed in, the bridge reports the
failure and stops; it will not attempt to authenticate on your behalf.

### No telemetry

The Plugin collects nothing and sends nothing anywhere except the Feishu Open
Platform, as described below. There is no analytics, no crash reporting, no usage
counter, no phone-home, and no update check. The only thing written to disk is
described under Data.

### Third-party service: Lark/Feishu

The only third party involved is the Lark/Feishu Open Platform, operated by ByteDance.
The bridge talks to it exclusively through your own `lark-cli`. It contacts:

| destination | why | data sent |
|---|---|---|
| `open.feishu.cn` (or `open.larksuite.com`) | read messages, send a message, edit a message, download an attachment | the message text of the conversation being watched, and the text the bridge writes back |
| the Lark/Feishu Open Platform auth host | token refresh, performed by `lark-cli` | whatever `lark-cli` sends; this Plugin does not read or store it |

Your Feishu organization applies its own retention and access policies to those
messages. Sending a task to this bridge means sending it to Feishu.

Nothing else is contacted: no registry, no CDN, no analytics endpoint, no GitHub, no
model provider beyond the MiniMax Code installation you already run locally.

## Data written to disk

All under the data directory, which is `$PLUGIN_DATA` when the runtime provides one,
otherwise `$MCODE_FEISHU_BRIDGE_DATA`, otherwise `~/.mcode-feishu-bridge`:

| path | contents |
|---|---|
| `state.json` | per chat: workspace path, mcode session id, last handled message id, turn count, and at most one pending delivery |
| `config.json` | only what you put in it; the bridge reads `chatId` and nothing else |
| `bridge.log` | the last run's log lines, rotated to `bridge.log.1` on each start |
| `bridge.lock` | the running pid |
| `workspaces/<chat-id>/` | the mcode working directory for that chat |
| `media/` | images and files downloaded from the chat, so mcode can read them |

`state.json` is written atomically (staged, fsynced, renamed), so an interrupted
write cannot leave a truncated file that would make the bridge reprocess the whole
conversation.

## Tests

```bash
node scripts/mcode-feishu-bridge.test.mjs
```

84 assertions. They import the real module rather than a copy, so a green run is
evidence about the shipped code. Coverage:

- edits to one message are serialised, so a slow tool hint cannot overwrite the answer
- a failed edit falls back to a reply instead of stranding the user on a placeholder
- delivery failure retries with a linear backoff and then gives up, never looping
- the watermark always advances, so a persistent failure cannot re-run mcode
- a hung mcode turn is killed as a process tree, and resolution waits for the process
  to actually exit
- one watcher at a time; a stale lock is reclaimed
- message paging and ordering, including a regression test built from a real
  conversation that had outgrown one page
- fetch problems throw rather than returning an empty list
- the source never routes a child process through a shell, and never sends `--text`

Two of these are regression tests for defects that shipped in an earlier draft and
were found in real use. Their comments record what actually happened, including the
measured numbers.

## Traps this Plugin works around

Each of these was reproduced, not anticipated. The code comments say the same thing
next to the fix.

1. **Never forward arguments through `cmd /c`.** Node builds a command line and
   `cmd.exe` parses it again. mcode answers can contain
   `<media type="file" src="…">` markup, and the `<`, `>` and `"` inside it are
   redirection and quote operators to `cmd`. The command is shredded: exit 1, empty
   stdout, empty stderr, no diagnosable cause, and a retry loop that floods the chat.
   Measured with one payload against one message: `cmd /c` → exit 1, no output;
   direct spawn → exit 0, delivered. Every child process here is spawned directly
   with `shell: false`.
2. **Message paging and ordering.** `--order asc --page-size 50` returns the
   *oldest* 50 messages. Once a conversation outgrows one page, new messages are
   invisible and the bridge looks alive but deaf, logging nothing. It now fetches the
   newest page and escalates to full pagination only when the watermark is not on it.
3. **Fetch problems must not be silent.** Returning a status code and trusting
   someone to check it is not a safeguard: deleting that one line left the whole
   suite green. `collectFresh` throws instead, so the only exit is a catch that
   already logs.
4. **A timeout has to wait for the process to die.** `taskkill` is asynchronous.
   Resolving immediately let the next message race a zombie mcode for the same
   workspace and session.
5. **Windows PowerShell 5.1 reads BOM-less UTF-8 as the local code page.** Relevant
   if you write a launcher script for it; not applicable to this Plugin, which ships
   no `.ps1`.

## When it does not work

| symptom | most likely cause | check |
|---|---|---|
| no reply at all, log says `fetch messages failed` | the **user** identity is not usable: token expired, or `offline_access` was never granted | `lark-cli auth status` — look at `identities.user` |
| the bridge never starts, exits 1 at launch | `lark-cli` or `mcode` is not on the `PATH` the bridge inherited | run `which lark-cli` / `which mcode` in that same environment |
| a reply appears, but it is always the failure notice | the **bot** identity cannot send, so even the fallback reply fails | `lark-cli auth status` — look at `identities.bot` |
| works for hours, then goes quiet | the user token expired because `offline_access` was not granted at authorisation time | re-authorise with `lark-cli auth login` and request that scope |
| attachments are ignored | missing `im:resource` | the app's permission list |
| nothing happens, and the log says the watermark is not on the page | the bridge fell too far behind and the full-pagination fallback also failed | restart the watcher; it re-reads the newest page |
| a second watcher refuses to start with exit 3 | one is already running, which is the point | `bridge.lock` holds its pid; use `--stop` |
| a turn is reported as timed out | mcode hung, most often on an interactive prompt | the notice names how many tool calls had already run; check the workspace |

None of these are silent: every one of them produces a line in `bridge.log`. If the
log is empty and the chat is silent, the watcher is not running at all.

The same table, in the order to work through it when a user reports silence, is in
[`skills/mcode-feishu-bridge/SKILL.md`](skills/mcode-feishu-bridge/SKILL.md), along
with the identity and scope pre-flight an agent should check before starting.

## License

Apache-2.0. See [LICENSE](LICENSE).
