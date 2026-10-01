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

## Install

The Plugin is Skill-only and has no `mcp.json` and no `package.json`. It needs two
CLIs that you already have or can install yourself:

| requirement | what it is | check |
|---|---|---|
| [`lark-cli`](https://www.npmjs.com/package/@larksuite/cli) | the official Lark/Feishu CLI, already configured for your account | `lark-cli auth status` |
| MiniMax Code | the agent, installed and runnable | `mcode --version` |

Then configure a conversation and start the bridge:

```bash
node scripts/mcode-feishu-bridge.mjs --watch --chat <your-chat-id>
```

How to obtain a chat id: send a message in the conversation, then

```bash
lark-cli im +chat-messages-list --chat-id <chat-id> --as user --format json
```

or list your conversations with `lark-cli im +chat-list --types=p2p,group --page-all --as user`.

Full operating instructions are in [`skills/mcode-feishu-bridge/SKILL.md`](skills/mcode-feishu-bridge/SKILL.md).

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

## License

Apache-2.0. See [LICENSE](LICENSE).
