# MiniMax Code 每日签到

> Complete MiniMax Code's daily check-in to claim free credits and manage the schedule of the
> automated check-in. v1.0.0.

## What it does

- Runs MiniMax Code's built-in daily check-in to claim free credits
  (400/day, 1000 on day 4 and day 7, 4000/week max, valid 30 days).
- Manages the cron that schedules the automated check-in: query current
  schedule, change the time, enable/disable.

## Install

After the plugin is merged into
[MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins):

```text
/plugin marketplace add MiniMax-AI/MiniMax-Code-Plugins
/plugin install minimax-code-checkin@RedMaple-mc2
```

## Example queries

- "帮我签到 MiniMax Code 领积分"
- "把自动签到改到晚上 8 点"
- "什么时候自动签到？"
- "关掉自动签到"

## Requirements

- **MiniMax Code ≥ v3.0.58** (released 2026-08-05). The check-in
  button lives on `Settings → Usage` (Web) or `/checkin` (desktop TUI).
- **Logged-in MiniMax Code session.** Either a Web session cookie or a
  desktop app OAuth cache with a valid access token. The skill will
  ask the user to log in on first run if neither is present.

## Network access

None. The skill does not call any external HTTP endpoint. It operates
against the user's already-open MiniMax Code session through the local
LLM-driven workflow and `mavis cron` CLI commands.

## Data use

The skill does not collect, store, or transmit any user data outside
the user's MiniMax Code session. It reads the existing OAuth cache or
browser cookie only to detect login state, and never writes those
tokens anywhere.

## Capabilities

| Type | Path | Notes |
|---|---|---|
| Skill | `skills/minimax-code-checkin/SKILL.md` | Run check-in + manage cron schedule |

## Plugin structure

This plugin lives at plugins/RedMaple-mc2/minimax-code-checkin/ inside the
community registry.

```text
minimax-code-checkin/
├── .minimax-plugin/plugin.json
├── README.md
├── LICENSE
├── icon.png
└── skills/
    └── minimax-code-checkin/
        ├── SKILL.md
        └── references/
            └── checkin-flow.md
```

## License

MIT. See `LICENSE`.