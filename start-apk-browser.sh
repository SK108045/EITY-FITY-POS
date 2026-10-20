#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "$SCRIPT_DIR/capacitor" ]; then
  CAP_DIR="$SCRIPT_DIR/capacitor"
elif [ -d "$SCRIPT_DIR/POS_APK/capacitor" ]; then
  CAP_DIR="$SCRIPT_DIR/POS_APK/capacitor"
else
  echo "Error: Could not locate capacitor directory."
  exit 1
fi

cd "$CAP_DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing required npm dependencies..."
  npm install
fi

if [ ! -f "www/sqlite-bridge.js" ]; then
  echo "Building SQLite bridge bundle..."
  npm run build:bridge
fi

exec node dev-server.js "$@"
