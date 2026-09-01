#!/bin/zsh
set -euo pipefail

ROOT="/Users/gleidsongouveia/OpenInstinct"
DOCKER_APP="$HOME/Applications/Docker.app"
DOCKER_BIN="$DOCKER_APP/Contents/Resources/bin"
RUNTIME_BIN="$HOME/.openinstinct/bin"

export PATH="$RUNTIME_BIN:/opt/homebrew/opt/node@24/bin:$DOCKER_BIN:/opt/homebrew/bin:/usr/bin:/bin"

if [[ ! -x "$DOCKER_BIN/docker" ]]; then
  print -u2 "Docker Desktop is not installed at $DOCKER_APP."
  exit 1
fi

if ! "$DOCKER_BIN/docker" info >/dev/null 2>&1; then
  open -a "$DOCKER_APP"
  print "Starting Docker Desktop…"
  for _ in {1..36}; do
    "$DOCKER_BIN/docker" info >/dev/null 2>&1 && break
    sleep 5
  done
fi

if ! "$DOCKER_BIN/docker" info >/dev/null 2>&1; then
  print -u2 "Docker Desktop did not become ready within 3 minutes."
  exit 1
fi

if ! security find-generic-password -a "$USER" -s "OpenInstinct KERNEL_API_KEY" -w >/dev/null 2>&1; then
  print "OpenInstinct needs a Kernel API key to run its browser agent."
  print -n "Paste the Kernel API key (stored only in your macOS Keychain): "
  read -rs KERNEL_API_KEY
  print
  [[ -n "$KERNEL_API_KEY" ]] || { print -u2 "No API key supplied."; exit 1; }
  security add-generic-password -U -a "$USER" -s "OpenInstinct KERNEL_API_KEY" -w "$KERNEL_API_KEY"
  unset KERNEL_API_KEY
fi

export KERNEL_API_KEY="$(security find-generic-password -a "$USER" -s "OpenInstinct KERNEL_API_KEY" -w)"
cd "$ROOT"
exec pnpm dev
