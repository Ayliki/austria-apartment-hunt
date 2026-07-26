#!/usr/bin/env bash
# Sets up the willhaben-apartment-hunt kit for Claude Code:
#   1. registers the willhaben-mcp MCP server (user scope)
#   2. installs the apartment-hunt skill into ~/.claude/skills

set -euo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "error: 'claude' CLI not found on PATH. Install Claude Code first: https://claude.com/claude-code" >&2
  exit 1
fi

echo "==> Registering willhaben MCP server (user scope)..."
claude mcp add -s user willhaben -- npx -y willhaben-mcp

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/.claude/skills/apartment-hunt"
SKILL_DEST="$HOME/.claude/skills/apartment-hunt"

echo "==> Installing apartment-hunt skill to $SKILL_DEST..."
mkdir -p "$HOME/.claude/skills"
cp -r "$SKILL_SRC" "$SKILL_DEST"

cat <<'EOF'

Done. Restart Claude Code (or start a new session) so the willhaben MCP
tools load, then try:

  "help me find a 2-bedroom flat in Vienna under €1200/month"

EOF
