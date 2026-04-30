#!/bin/bash
# UserPromptSubmit: Scans for unlinked AGENTS.md files and injects new ones.
#
# Tracks already-injected files in a temp file to avoid re-injection.
# Creates CLAUDE.md (or prepends @AGENTS.md) for any new AGENTS.md found.
# Injects new AGENTS.md content via stdout for the current session.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TRACK_FILE="${TMPDIR:-/tmp}/agents-md-injected-${SESSION_ID:-$$}"

# Stage logging — set CLAUDE_AGENTS_MD_DEBUG=1 to get per-stage timings in
# CLAUDE_AGENTS_MD_DEBUG_LOG (default ~/.claude/agents-md-debug.log). Useful
# when you suspect this hook is causing UserPromptSubmit lag — `tail -f` the
# log while you trigger a prompt and see which stage is slow.
DEBUG="${CLAUDE_AGENTS_MD_DEBUG:-0}"
DEBUG_LOG="${CLAUDE_AGENTS_MD_DEBUG_LOG:-$HOME/.claude/agents-md-debug.log}"
_now_ms() {
  /usr/bin/python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null \
    || echo $(($(date +%s) * 1000))
}
_t0=$(_now_ms)
_tprev=$_t0
log_stage() {
  [ "$DEBUG" = "1" ] || return 0
  local now total step
  now=$(_now_ms)
  total=$((now - _t0))
  step=$((now - _tprev))
  _tprev=$now
  printf '%s  pid=%-6d  +%5dms (Δ%5dms)  %s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$$" "$total" "$step" "$1" \
    >> "$DEBUG_LOG"
}
log_stage "start  PROJECT_DIR=$PROJECT_DIR  cwd=$(pwd)"

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
    log_stage "bail   reason=home-or-root  resolved=$resolved_dir"
    exit 0
  fi
fi
log_stage "guard  passed home/root check"

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

# Prefer `git ls-files` when inside a git repo — honors .gitignore exactly
# (including nested .gitignore files and negation patterns), much faster than
# walking the tree, and covers tracked + untracked-not-ignored files. Falls
# back to fd/find on non-git trees.
git_root=$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null)
log_stage "git    root=${git_root:-<none>}"

if [ -n "$git_root" ]; then
  log_stage "scan   strategy=git-ls-files  root=$git_root"
  raw=$($TIMEOUT_CMD git -C "$git_root" ls-files --cached --others --exclude-standard 2>/dev/null \
    | grep -E '(^|/)AGENTS\.md$')
  files=""
  while IFS= read -r rel; do
    [ -z "$rel" ] && continue
    files="${files}${git_root}/${rel}"$'\n'
  done <<< "$raw"
  log_stage "scan   done count=$(printf '%s' "$files" | grep -c .)"
elif command -v fd &>/dev/null; then
  FD_EXCLUDES=""
  for ex in $EXCLUDES; do
    FD_EXCLUDES="$FD_EXCLUDES -E $ex"
  done
  log_stage "scan   strategy=fd  dir=$PROJECT_DIR  timeout=${SCAN_TIMEOUT}s"
  files=$($TIMEOUT_CMD fd -t f -H $FD_EXCLUDES '^AGENTS\.md$' "$PROJECT_DIR" 2>/dev/null)
  log_stage "scan   done count=$(printf '%s' "$files" | grep -c .)"
else
  FIND_EXCLUDES=""
  for ex in $EXCLUDES; do
    FIND_EXCLUDES="$FIND_EXCLUDES -not -path */$ex/*"
  done
  log_stage "scan   strategy=find  dir=$PROJECT_DIR  timeout=${SCAN_TIMEOUT}s"
  files=$($TIMEOUT_CMD find "$PROJECT_DIR" -name "AGENTS.md" $FIND_EXCLUDES 2>/dev/null)
  log_stage "scan   done count=$(printf '%s' "$files" | grep -c .)"
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
log_stage "end    injected=$injected"

exit 0
