---
name: omarchy-audit
description: >
  Use when auditing an Omarchy checkout for security issues, triaging shellcheck output
  from omarchy's scripts, or preparing a report for the Omarchy HackerOne bug bounty.
  Triggers on "audit omarchy", "hunt for vulnerabilities in omarchy", "sweep the omarchy
  bin scripts", "is this already fixed", "prepare a bug bounty report", "triage this
  shellcheck finding". Covers shebang-based script discovery, batched static analysis, and
  the v4.0.1-v4.0.3 already-fixed map so patched issues are not re-reported.
---

# Omarchy security audit

Static triage for an Omarchy checkout. Everything here is read-only and offline.

## The three things that go wrong

**1. Extension-based discovery finds nothing.** Omarchy's `bin/` ships 444 scripts and
**none** of them end in `.sh` — they are extensionless. The 464 files that *do* end in
`.sh` live in `test/`, `migrations/`, and `install/`. So:

```bash
find bin -name '*.sh'          # WRONG: 0 results
find bin -type f | head        # 444 files
```

Use this tool, which detects scripts by shebang:

```bash
mcp: omarchy-audit.discover_scripts(root="/path/to/omarchy")
```

**2. The default branch is not the release branch.** `omacom/omarchy`'s default branch is
`quattro`, whose `version` file reads `4.0.0.alpha` — that is a *pre-4.0.0* line. The
current release is the `v4.0.4` tag, and the `version` file is not maintained per tag, so
it is not a reliable indicator either. Check out the tag that ships:

```bash
git clone -b v4.0.4 --depth 1 https://github.com/omacom/omarchy.git
```

A finding on the wrong branch is either already fixed for users or unreachable for them.
Both are instant triage rejections.

**3. "Root-reachable" does not mean "runs as root".** A broad grep for scripts that lack
`export PATH=` returns ~67 hits in `bin/`, and every one of them is a false positive: they
run as the *user* and merely *call* `sudo`, so sudo's own `secure_path` governs the child.
Only scripts actually **invoked as root** need the PATH pin. In v4.0.4 that set is tiny —
`/usr/bin/omarchy-dns`, `/usr/bin/omarchy-theme-set-browser-policy`, and `/usr/bin/timedatectl`
— and both omarchy ones already have the fix. Enumerate the real entry points first:

```bash
ls etc/sudoers.d/ && cat etc/sudoers.d/*
```

## Procedure

1. **Scope.** Pick the tag users actually run. Record it in the findings table; a report
   without an affected version is not eligible.
2. **Map what is already fixed.** 27 security fixes shipped in v4.0.1, v4.0.2, and
   v4.0.3 — most summaries list only 8, which is how a family gets re-reported.

   ```bash
   mcp: omarchy-audit.known_fixed()
   ```

   Each entry names the *remedy*, not just the bug, because the hunt is for siblings that
   lack the remedy. Omarchy's three defence layers, in order of strength:
   - an argument **regex in sudoers itself** (`etc/sudoers.d/omarchy-tzupdate` anchors it)
   - an **allowlist in the script** (`case "${1:-}"` in `bin/omarchy-dns`)
   - a **PATH pin when `EUID == 0`** (`export PATH=/usr/local/sbin:...`)

   `bin/omarchy-dns` is the reference implementation of all three, with comments explaining
   why each exists. Read it before judging a sibling.

3. **Discover and analyse.**

   ```bash
   mcp: omarchy-audit.shellcheck_run(root="/path/to/omarchy", severity="warning")
   ```

   Start at `warning`. `info` adds SC2086 (unquoted expansion) and floods the table; treat
   it as a review aid, not a finding generator.

4. **Trace the data flow by hand.** This is the actual job and no tool does it. For each
   hit, answer: *where does this value come from?* A filename, a USB device name, a media
   title, a notification body, an env var, a printer name, a network name. Then: *is it
   already trusted at that point?* An unquoted expansion of a value the script itself just
   set is not a vulnerability. Every confirmed bug in Omarchy's history took untrusted
   input from the physical or network boundary and reached a shell or an interpreter.

5. **Record every row, including the rejects.** Status is one of
   `new`, `already-fixed`, `needs-PoC`, `confirmed`, `false-positive`. A false positive
   with a one-line reason is a real result — it stops the next person re-deriving it.

6. **Propose, never run.** For a hit that survives triage, write the PoC plan and show it
   before executing. Any dynamic PoC belongs inside `bwrap` with `--unshare-net` and a
   read-only bind of the target. No sudo, no host mounts, no installs.

## The boundary test

A report pays only if a **lower-privileged or untrusted party gains something they did not
have**. Rewards are CVSS-banded (Low $250, Medium $750, High $1,500, Critical higher) and
upstream dependency bugs, third-party services, and documentation or example code are all
**out of scope for payment**.

If the answer to "who gains what" is "nobody, it would just be cleaner", it is an
improvement, not a vulnerability — still worth a PR, not worth a report.

## Boundaries this Skill enforces

- Never execute a script found in the target tree. shellcheck reads files; it does not run
  them. This Skill spawns only shellcheck.
- Never write to the target tree, and make no network calls.
- Never submit anything to HackerOne or `security@omarchy.org`. Produce a draft; a human
  sends it.
- Never report anything already in the fix map, and check the target's changelog first.
- Never run a PoC without explicit per-instance approval.

## Output

A findings table: `component | file:line | rule | severity | status`, each row citing the
line and naming the untrusted source. A draft report per confirmed finding, using the
component, version, boundary crossed, before/after impact, repro, PoC, and suggested fix.
