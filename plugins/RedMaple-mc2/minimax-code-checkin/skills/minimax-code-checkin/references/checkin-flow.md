# Check-in Flow Reference

Background material for `minimax-code-checkin`. The SKILL.md body only
references this file when the version-aware route fails or the user
needs manual steps.

## Versions and entry points

- **< v3.0.58**: no first-class check-in button. Skip the skill —
  tell the user to upgrade.
- **v3.0.58 — 2026-08-05**: check-in added.
  - Web: `Settings → Usage` page, top card.
  - Desktop TUI: `/checkin` slash command.
  - Reward: 400 / day, 1000 on day 4 and day 7, 4000 / week max.
  - Credit validity: 30 days from issuance.
- **≤ 2026-09-15 (H3 promo)**: check-in credits and paid credits both
  usable for MiniMax H3 video generation. After 2026-09-15: paid
  credits only for H3.

## Region URLs

- 国内: `https://agent.minimaxi.com/docs/code/account/usage` (doc),
  `https://agent.minimaxi.com` (app).
- 海外: `https://agent.minimax.io/docs/code/account/usage` (doc),
  `https://agent.minimax.io` (app).

Pick by inspecting the user's existing cookie or by which
`agent.minimax*.com` URL the user opens first.

## Manual fallback (if automation never works)

1. Open the region URL above in a browser where you're logged in.
2. Settings → Usage → click 立即签到.
3. Done.

## Why this file exists

`SKILL.md` is kept short so the model can decide quickly. This
reference carries the version timeline, region URLs, and the manual
fallback so a model that probes a non-existent surface can still
help the user.