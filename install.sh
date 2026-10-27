#!/usr/bin/env bash
# Install or update the Cross-Model Advisor plugin into ~/.gemini/config/plugins/advisor/
# Usage: bash install.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.gemini/config/plugins/advisor"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$HOME/.gemini/config/plugins" "$DEST_DIR" "$BIN_DIR"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude='.git' --exclude='install.sh' "$SRC_DIR/" "$DEST_DIR/"
else
  for item in plugin.json mcp_config.json README.md assets bin mcp agents skills rules; do
    if [[ -e "$SRC_DIR/$item" ]]; then
      tmp="$DEST_DIR/.$item.new.$$"
      rm -rf "$tmp"
      cp -R "$SRC_DIR/$item" "$tmp"
      rm -rf "$DEST_DIR/$item"
      mv "$tmp" "$DEST_DIR/$item"
    fi
  done
fi

chmod +x "$DEST_DIR/bin/advisor-consult" "$DEST_DIR/bin/run-mcp-server" "$DEST_DIR/mcp/advisor-server.mjs"
ln -sf "$DEST_DIR/bin/advisor-consult" "$BIN_DIR/advisor-consult"

if command -v agy >/dev/null 2>&1; then
  agy plugin validate "$DEST_DIR" --strict
  agy plugin enable advisor 2>/dev/null || true
elif [[ -x "$HOME/.local/bin/agy" ]]; then
  "$HOME/.local/bin/agy" plugin validate "$DEST_DIR" --strict
  "$HOME/.local/bin/agy" plugin enable advisor 2>/dev/null || true
fi

echo "Installed Cross-Model Advisor plugin to $DEST_DIR and linked $BIN_DIR/advisor-consult"
