#!/usr/bin/env bash
# Install or update the Cross-Model Advisor plugin into ~/.gemini/config/plugins/advisor/
# Usage: bash install.sh

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.gemini/config/plugins/advisor"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$HOME/.gemini/config/plugins" "$DEST_DIR" "$BIN_DIR"

# Prevent ~/.local/bin/env (uv/rustup source script) from shadowing /usr/bin/env if +x was set
if [[ -f "$BIN_DIR/env" && -x "$BIN_DIR/env" ]]; then
  chmod -x "$BIN_DIR/env"
fi

# Validate source plugin structure before modifying installed plugin directory
if command -v agy >/dev/null 2>&1; then
  agy plugin validate "$SRC_DIR" --strict
elif [[ -x "$HOME/.local/bin/agy" ]]; then
  "$HOME/.local/bin/agy" plugin validate "$SRC_DIR" --strict
fi

# Clean up legacy pre-1.3 orphaned MCP schema cache directory if present
rm -rf "$HOME/.gemini/antigravity/mcp/advisor_advisor-mcp" 2>/dev/null || true

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude='.git' \
    --exclude='.github' \
    --exclude='node_modules' \
    --exclude='install.sh' \
    "$SRC_DIR/" "$DEST_DIR/"
else
  for item in plugin.json mcp_config.json hooks.json README.md assets bin mcp agents skills rules; do
    if [[ -e "$SRC_DIR/$item" ]]; then
      tmp="$DEST_DIR/.$item.new.$$"
      rm -rf "$tmp"
      cp -R "$SRC_DIR/$item" "$tmp"
      rm -rf "$DEST_DIR/$item"
      mv "$tmp" "$DEST_DIR/$item"
    fi
  done
fi

chmod +x "$DEST_DIR/bin/advisor-consult" "$DEST_DIR/bin/advisor-hook" "$DEST_DIR/bin/run-mcp-server" "$DEST_DIR/mcp/advisor-server.mjs"
ln -sf "$DEST_DIR/bin/advisor-consult" "$BIN_DIR/advisor-consult"

# Refresh cached MCP tool schema files in ~/.gemini/antigravity/mcp/advisor_mcp if present
NODE_CMD="node"
if [[ -x "$HOME/opt/node/bin/node" ]]; then
  NODE_CMD="$HOME/opt/node/bin/node"
elif [[ -x "$HOME/.local/bin/node" ]]; then
  NODE_CMD="$HOME/.local/bin/node"
fi
if command -v "$NODE_CMD" >/dev/null 2>&1; then
  "$NODE_CMD" --input-type=module - "$DEST_DIR/mcp/advisor-core.mjs" <<'EOF' 2>/dev/null || true
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { TOOLS } = await import(pathToFileURL(process.argv[2]).href);
const mcpCacheDir = path.join(os.homedir(), ".gemini/antigravity/mcp/advisor_mcp");
if (fs.existsSync(path.dirname(mcpCacheDir))) {
  fs.mkdirSync(mcpCacheDir, { recursive: true });
  for (const t of TOOLS) {
    const out = { name: t.name, description: t.description, parameters: t.inputSchema };
    fs.writeFileSync(path.join(mcpCacheDir, `${t.name}.json`), JSON.stringify(out));
  }
}
EOF
fi

if command -v agy >/dev/null 2>&1; then
  agy plugin validate "$DEST_DIR" --strict
  agy plugin enable advisor 2>/dev/null || true
elif [[ -x "$HOME/.local/bin/agy" ]]; then
  "$HOME/.local/bin/agy" plugin validate "$DEST_DIR" --strict
  "$HOME/.local/bin/agy" plugin enable advisor 2>/dev/null || true
fi

echo "Installed Cross-Model Advisor plugin to $DEST_DIR and linked $BIN_DIR/advisor-consult"
