#!/usr/bin/env bash
# Install or update the portable Antigravity + MuseCode environment:
#   1. Global ~/.gemini/config/AGENTS.md (and ~/AGENTS.md symlink)
#   2. Global skills (~/.gemini/config/skills/{ea-prose,ea-publish})
#   3. Cross-Model Advisor CLI & plugin (~/.local/bin/advisor-consult & ~/.gemini/config/plugins/advisor/)
#      Default: keeps advisor MCP plugin disabled in ~/.gemini/config/config.json so normal turns stay fast
#      and lean (pass --enable-plugin to enable the always-loaded MCP plugin).
# Usage: bash install.sh [--enable-plugin]

set -euo pipefail

ENABLE_PLUGIN=0
for arg in "$@"; do
  if [[ "$arg" == "--enable-plugin" ]]; then
    ENABLE_PLUGIN=1
  fi
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$HOME/.gemini/config"
DEST_DIR="$CONFIG_DIR/plugins/advisor"
SKILLS_DIR="$CONFIG_DIR/skills"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$CONFIG_DIR/plugins" "$DEST_DIR" "$SKILLS_DIR" "$BIN_DIR"

# Prevent ~/.local/bin/env (uv/rustup source script) from shadowing /usr/bin/env if +x was set
if [[ -f "$BIN_DIR/env" && -x "$BIN_DIR/env" ]]; then
  chmod -x "$BIN_DIR/env"
fi

# 1. Sync global AGENTS.md and ~/AGENTS.md symlink
if [[ -f "$SRC_DIR/global/AGENTS.md" ]]; then
  cp "$SRC_DIR/global/AGENTS.md" "$CONFIG_DIR/AGENTS.md"
  ln -snf "$CONFIG_DIR/AGENTS.md" "$HOME/AGENTS.md"
fi

# 2. Sync global skills (ea-prose, ea-publish)
if [[ -d "$SRC_DIR/global/skills" ]]; then
  cp -R "$SRC_DIR/global/skills/." "$SKILLS_DIR/"
fi

# Clean up legacy pre-1.3 orphaned MCP schema cache directory if present
rm -rf "$HOME/.gemini/antigravity/mcp/advisor_advisor-mcp" 2>/dev/null || true

# 3. Sync advisor plugin files (excluding repo-only global/ and install.sh)
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude='.git' \
    --exclude='.github' \
    --exclude='node_modules' \
    --exclude='install.sh' \
    --exclude='global' \
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
  if [[ "$ENABLE_PLUGIN" -eq 1 ]]; then
    agy plugin enable advisor 2>/dev/null || true
  else
    agy plugin disable advisor 2>/dev/null || true
    agy plugin disable egm 2>/dev/null || true
  fi
elif [[ -x "$HOME/.local/bin/agy" ]]; then
  "$HOME/.local/bin/agy" plugin validate "$DEST_DIR" --strict
  if [[ "$ENABLE_PLUGIN" -eq 1 ]]; then
    "$HOME/.local/bin/agy" plugin enable advisor 2>/dev/null || true
  else
    "$HOME/.local/bin/agy" plugin disable advisor 2>/dev/null || true
    "$HOME/.local/bin/agy" plugin disable egm 2>/dev/null || true
  fi
fi

echo "Synced global AGENTS.md, skills (ea-prose, ea-publish), and advisor-consult (MuseCode + Claude)."
