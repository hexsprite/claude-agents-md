#!/bin/sh
# agents-md v2 installer.
#
# Installs the CLAUDE.md<-AGENTS.md VFS for Claude Code:
#   1. drops agents-md-vfs.js into ~/.claude/
#   2. injects a marker-guarded, call-time-merge `claude` shell function into
#      the user's rc file(s), so BUN_OPTIONS carries the preload into claude
#      (and ONLY claude — the helper self-gates, see agents-md-vfs.js).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/hexsprite/claude-agents-md/main/install.sh | sh
#   # local dev: AGENTS_MD_VFS_SRC=./agents-md-vfs.js sh install.sh
set -eu

VFS_DEST="${HOME}/.claude/agents-md-vfs.js"
RAW_URL="https://raw.githubusercontent.com/hexsprite/claude-agents-md/main/agents-md-vfs.js"
BEGIN="# >>> agents-md vfs >>>"
END="# <<< agents-md vfs <<<"

# --- 1. place the helper -----------------------------------------------------
mkdir -p "${HOME}/.claude"
if [ -n "${AGENTS_MD_VFS_SRC:-}" ]; then
  cp "$AGENTS_MD_VFS_SRC" "$VFS_DEST"
else
  curl -fsSL "$RAW_URL" -o "$VFS_DEST"
fi
echo "agents-md: helper -> $VFS_DEST"

# --- 2. the managed rc block -------------------------------------------------
# Call-time merge: reads whatever BUN_OPTIONS exists at invocation, appends our
# --require iff not already present, scoped to this one claude exec. Composes
# with other setters (direnv etc.) instead of clobbering.
block() {
  cat <<'BLOCK'
# >>> agents-md vfs >>>
claude() {
  local _vfs="$HOME/.claude/agents-md-vfs.js"
  case " ${BUN_OPTIONS:-} " in
    *" --require $_vfs "*) ;;                                   # already present
    *) BUN_OPTIONS="${BUN_OPTIONS:+$BUN_OPTIONS }--require $_vfs" ;;
  esac
  BUN_OPTIONS="$BUN_OPTIONS" command claude "$@"
}
# <<< agents-md vfs <<<
BLOCK
}

inject() {
  rc="$1"
  [ -e "$rc" ] || return 0
  if grep -qF "$BEGIN" "$rc" 2>/dev/null; then
    echo "agents-md: block already in $rc (skipping)"
    return 0
  fi
  printf '\n%s\n' "$(block)" >> "$rc"
  echo "agents-md: installed shell function in $rc"
}

injected=0
for rc in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  if [ -e "$rc" ]; then
    inject "$rc"
    injected=1
  fi
done

# Fresh account with no rc file yet (common on new macOS — zsh is the default
# shell but ~/.zshrc often doesn't exist). Without this, `curl | sh` would drop
# the helper and silently no-op. Create the rc matching the login shell and
# inject, mirroring what nvm/rustup/brew do.
if [ "$injected" = 0 ]; then
  case "${SHELL:-}" in
    */bash) rc="${HOME}/.bashrc" ;;
    *)      rc="${HOME}/.zshrc"  ;;   # zsh = macOS default; safe fallback
  esac
  if touch "$rc" 2>/dev/null; then
    echo "agents-md: created $rc (no shell rc existed)"
    inject "$rc"
    injected=1
  fi
fi

# fish uses a different function/env syntax — not handled by this installer.
if [ -e "${HOME}/.config/fish/config.fish" ]; then
  echo "agents-md: fish detected — not supported by this installer yet (zsh/bash only)."
fi

echo
echo "agents-md v2 installed. Open a NEW shell (or 'source' your rc) to activate."
echo "Recommended: remove the legacy plugin so it stops double-injecting:"
echo "    /plugin uninstall agents-md@hexsprite"
[ "$injected" = 1 ] || echo "WARN: could not write a shell rc — add the function manually (see README)."
