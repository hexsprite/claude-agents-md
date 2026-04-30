#!/bin/bash
# UserPromptSubmit: Scans for unlinked AGENTS.md files and injects new ones.
#
# Tracks already-injected files in a temp file to avoid re-injection.
# Creates CLAUDE.md (or prepends @AGENTS.md) for any new AGENTS.md found.
# Injects new AGENTS.md content via stdout for the current session.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TRACK_FILE="${TMPDIR:-/tmp}/agents-md-injected-${SESSION_ID:-$$}"

# Bail when PROJECT_DIR is $HOME or filesystem root — scanning trees that
# large (Library, iCloud, mounted volumes) makes the hook hang for minutes
# on every prompt. AGENTS.md scanning is meant for project trees, not $HOME.
# Override with CLAUDE_AGENTS_MD_ALLOW_HOME=1 if you keep AGENTS.md at $HOME
# (e.g. dotfiles repo rooted there).
if [ "${CLAUDE_AGENTS_MD_ALLOW_HOME:-0}" != "1" ]; then
  resolved_dir=$(cd "$PROJECT_DIR" 2>/dev/null && pwd -P)
  resolved_home=$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P)
  if [ -z "$resolved_dir" ] || [ "$resolved_dir" = "/" ] || \
     { [ -n "$resolved_home" ] && [ "$resolved_dir" = "$resolved_home" ]; }; then
    exit 0
  fi
fi

# Ensure tracking file exists
touch "$TRACK_FILE"

EXCLUDES="node_modules .git vendor dist build .next .cache __pycache__ .venv"

# Cap total scan time. Pathological trees (network mounts, FUSE, deep
# symlink loops) can otherwise keep the hook running for minutes.
SCAN_TIMEOUT="${CLAUDE_AGENTS_MD_SCAN_TIMEOUT:-5}"
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout $SCAN_TIMEOUT"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout $SCAN_TIMEOUT"
else
  TIMEOUT_CMD=""
fi

# Use fd if available (faster), otherwise fall back to find
if command -v fd &>/dev/null; then
  FD_EXCLUDES=""
  for ex in $EXCLUDES; do
    FD_EXCLUDES="$FD_EXCLUDES -E $ex"
  done
  files=$($TIMEOUT_CMD fd -t f -H $FD_EXCLUDES '^AGENTS\.md$' "$PROJECT_DIR" 2>/dev/null)
else
  FIND_EXCLUDES=""
  for ex in $EXCLUDES; do
    FIND_EXCLUDES="$FIND_EXCLUDES -not -path */$ex/*"
  done
  files=$($TIMEOUT_CMD find "$PROJECT_DIR" -name "AGENTS.md" $FIND_EXCLUDES 2>/dev/null)
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
    # Prefer a relative symlink so edits to AGENTS.md show up in CLAUDE.md
    # with zero duplication, and build watchers that see "new file under src/"
    # don't get tripped by an extra real file. Fall back to the @AGENTS.md
    # text file on platforms where symlinks fail (Windows without Developer
    # Mode, some network / container mounts) or when the user opts out.
    if [ "${CLAUDE_AGENTS_MD_NO_SYMLINK:-0}" = "1" ] || ! ln -s "AGENTS.md" "$claude_md" 2>/dev/null; then
      echo "@AGENTS.md" > "$claude_md"
    fi
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
