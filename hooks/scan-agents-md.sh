#!/bin/bash
# UserPromptSubmit: Scans for unlinked AGENTS.md files and injects new ones.
#
# Tracks already-injected files in a temp file to avoid re-injection.
# Creates CLAUDE.md (or prepends @AGENTS.md) for any new AGENTS.md found.
# Injects new AGENTS.md content via stdout for the current session.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TRACK_FILE="${TMPDIR:-/tmp}/agents-md-injected-${SESSION_ID:-$$}"

# Ensure tracking file exists
touch "$TRACK_FILE"

EXCLUDES="node_modules .git vendor dist build .next .cache __pycache__ .venv"

# Use fd if available (faster), otherwise fall back to find
if command -v fd &>/dev/null; then
  FD_EXCLUDES=""
  for ex in $EXCLUDES; do
    FD_EXCLUDES="$FD_EXCLUDES -E $ex"
  done
  files=$(fd -t f -H $FD_EXCLUDES '^AGENTS\.md$' "$PROJECT_DIR" 2>/dev/null)
else
  FIND_EXCLUDES=""
  for ex in $EXCLUDES; do
    FIND_EXCLUDES="$FIND_EXCLUDES -not -path */$ex/*"
  done
  files=$(find "$PROJECT_DIR" -name "AGENTS.md" $FIND_EXCLUDES 2>/dev/null)
fi

injected=0

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Skip if already injected this session
  if grep -qxF "$file" "$TRACK_FILE" 2>/dev/null; then
    continue
  fi

  dir=$(dirname "$file")
  claude_md="$dir/CLAUDE.md"

  # If CLAUDE.md is a symlink pointing at this AGENTS.md, user already has
  # equivalence set up — skip to avoid clobbering the symlink and causing
  # double-injection via @AGENTS.md + inlined content.
  if [ -L "$claude_md" ]; then
    link_target=$(readlink "$claude_md")
    case "$link_target" in
      /*) resolved="$link_target" ;;
      *)  resolved="$dir/$link_target" ;;
    esac
    if [ "$(cd "$(dirname "$resolved")" 2>/dev/null && pwd)/$(basename "$resolved")" = "$(cd "$dir" && pwd)/$(basename "$file")" ]; then
      echo "$file" >> "$TRACK_FILE"
      continue
    fi
  fi

  # Create or prepend CLAUDE.md
  if [ ! -e "$claude_md" ] && [ ! -L "$claude_md" ]; then
    echo "@AGENTS.md" > "$claude_md"
  elif ! grep -q "^@AGENTS.md" "$claude_md"; then
    tmp=$(mktemp)
    printf '@AGENTS.md\n---\n\n' | cat - "$claude_md" > "$tmp" && mv "$tmp" "$claude_md"
  fi

  # Inject via stdout for current session
  echo "=== AGENTS.md ($dir) ==="
  cat "$file"

  # Track as injected
  echo "$file" >> "$TRACK_FILE"
  injected=$((injected + 1))
done <<< "$files"

if [ $injected -gt 0 ]; then
  echo "agents-md: injected $injected new AGENTS.md file(s)" >&2
fi

exit 0
