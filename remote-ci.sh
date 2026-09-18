#!/usr/bin/env bash
# remote-ci.sh — Run the full repository gate on the Ubuntu server (ssh: siinfer),
# mirroring CI / validate (ubuntu-latest) as closely as the host allows.
# Differences vs GitHub ubuntu-latest: Node 24 here vs 22 there (within the plugin's
# declared support), and no CodeQL/Windows jobs.
# Usage: ./remote-ci.sh [branch]   (default: current branch of the local clone)
set -euo pipefail
BRANCH="${1:-$(git -C "$(dirname "$0")" rev-parse --abbrev-ref HEAD)}"
LOCAL_DIR="$(dirname "$0")"
HOST="${SIH_REMOTE:-siinfer}"
REMOTE_BASE="${SIH_REMOTE_DIR:-remote-ci/MiniMax-Code-Plugins}"
SHA="$(git -C "$LOCAL_DIR" rev-parse "$BRANCH")"

echo "[remote-ci] branch=$BRANCH sha=${SHA:0:8} host=$HOST"

# 1. Ship the exact tree (tar over ssh; no GitHub round-trip, works for unpushed heads).
#    COPYFILE_DISABLE silences macOS tar provenance xattrs.
ssh "$HOST" "rm -rf \"\$HOME/$REMOTE_BASE\" && mkdir -p \"\$HOME/$REMOTE_BASE\""
COPYFILE_DISABLE=1 tar -C "$LOCAL_DIR" --exclude=.git --exclude=node_modules \
    --exclude='*/node_modules' -cf - . \
  | ssh "$HOST" "cd \"\$HOME/$REMOTE_BASE\" && tar -xf -"

# 2. Install dev deps for the plugin (pinned) plus the CI runner's Python deps
#    (Pillow — see .github/workflows/ci.yml), then run the full gate from a clean
#    tree (node_modules removed — same as the CI runner's fresh checkout).
ssh "$HOST" 'set -e
  cd "$HOME/'"$REMOTE_BASE"'"
  echo "[remote-ci] node $(node --version)"
  (cd plugins/hetaoBackend/mcode-dynamic-workflows && npm ci --no-audit --no-fund >/dev/null 2>&1)
  python3 -m venv .venv-ci 2>/dev/null || true
  .venv-ci/bin/pip install --quiet --disable-pip-version-check Pillow 2>/dev/null \
    || echo "[remote-ci] WARN: Pillow install failed; octopus tests may fail"
  export PATH="$PWD/.venv-ci/bin:$PATH"
  rm -rf plugins/hetaoBackend/mcode-dynamic-workflows/node_modules
  npm run check'

echo "[remote-ci] FULL GATE GREEN on $HOST (${SHA:0:8})"
