#!/usr/bin/env bash
# Cellmap Viewer launcher (macOS) — double-click in Finder to run the Electron app.
# (No install needed just to VIEW data: open CellmapViewer.html in a browser.)
# First time, if double-click is blocked: chmod +x run-mac.command
set -e
cd "$(dirname "$0")"

# Prefer a portable Node bundled in the folder (tools/node/<platform>), else system Node.
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) A=x64;; arm64|aarch64) A=arm64;; *) A="$ARCH";; esac
BUNDLED="$PWD/tools/node/darwin-$A/bin"
if [ -x "$BUNDLED/node" ]; then export PATH="$BUNDLED:$PATH"; fi

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  No Node.js found. Either:"
  echo "    - open CellmapViewer.html in a browser (no install), or"
  echo "    - install Node 18+ from https://nodejs.org/ , or"
  echo "    - drop a portable Node into tools/node/darwin-$A/ ."
  echo
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -d node_modules/electron/dist ]; then
  echo "First run: installing dependencies. This can take a few minutes..."
  npm install --no-fund --no-audit
fi

if [ ! -f dist/index.html ]; then
  echo "First run: building the app..."
  npm run build
fi

exec ./node_modules/.bin/electron .
