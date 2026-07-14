#!/bin/sh
# agents-md v2 uninstaller.
# Removes the marker-guarded block from rc files and the helper. No other
# state is touched (the installer never wrote anything else).
set -eu

VFS_DEST="${HOME}/.claude/agents-md-vfs.js"
BEGIN="# >>> agents-md vfs >>>"
END="# <<< agents-md vfs <<<"

strip() {
  rc="$1"
  [ -e "$rc" ] || return 0
  grep -qF "$BEGIN" "$rc" 2>/dev/null || return 0
  # delete the inclusive marker block, plus the leading blank line the
  # installer put before it (printf '\n%s\n' in install.sh's inject()).
  tmp="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '
    { lines[NR] = $0 }
    $0==b { begin=NR }
    $0==e { end=NR }
    END {
      start = begin
      if (begin > 1 && lines[begin-1] == "") start = begin - 1
      for (i=1; i<=NR; i++) {
        if (i >= start && i <= end) continue
        print lines[i]
      }
    }
  ' "$rc" > "$tmp"
  # Only the marker block + the one leading blank the installer added are
  # removed — nothing else in the file is touched (matches the README claim).
  mv "$tmp" "$rc"
  echo "agents-md: removed shell function from $rc"
}

for rc in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  strip "$rc"
done

if [ -e "$VFS_DEST" ]; then
  rm -f "$VFS_DEST"
  echo "agents-md: removed $VFS_DEST"
fi

echo "agents-md v2 uninstalled. Open a new shell to drop the function."
