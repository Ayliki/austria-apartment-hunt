#!/usr/bin/env bash
# Sets up the austria-apartment-hunt kit for Claude Code:
#   1. builds immoscout-mcp and apt-hunter
#   2. registers the willhaben + immoscout MCP servers (user scope)
#   3. installs the apartment-hunt skill into ~/.claude/skills

set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH. Install Claude Code first: https://claude.com/claude-code" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH. Install Node.js >= 18 first." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Building immoscout-mcp..."
(cd "$SCRIPT_DIR/immoscout-mcp" && npm install && npm run build)

echo "==> Building apt-hunter..."
(cd "$SCRIPT_DIR/apt-hunter" && npm install && npm run build)

echo "==> Building swipe-bot..."
(cd "$SCRIPT_DIR/swipe-bot" && npm install && npm run build)

echo "==> Registering MCP servers (user scope)..."

# Remove any previously-registered entries so the script is idempotent on re-runs.
claude mcp remove -s user willhaben 2>/dev/null || true
claude mcp remove -s user immoscout 2>/dev/null || true
claude mcp remove -s user swipe-bot 2>/dev/null || true

claude mcp add -s user willhaben -- npx -y willhaben-mcp
claude mcp add -s user immoscout -- node "$SCRIPT_DIR/immoscout-mcp/dist/index.js"
claude mcp add -s user swipe-bot -- node "$SCRIPT_DIR/swipe-bot/dist/mcp-server.js"

SKILL_SRC="$SCRIPT_DIR/.claude/skills/apartment-hunt"
SKILL_DEST="$HOME/.claude/skills/apartment-hunt"
echo "==> Installing apartment-hunt skill to $SKILL_DEST..."
mkdir -p "$HOME/.claude/skills"
cp -r "$SKILL_SRC" "$SKILL_DEST"

cat <<EOF

Done. Restart Claude Code (or start a new session) so the MCP tools load, then try:

  "help me find a rental flat in Vienna under €700 in districts 1-9"

Or run the CLI directly:
  node "$SCRIPT_DIR/apt-hunter/dist/cli.js" --price-to 700 --districts 1-9

EOF
