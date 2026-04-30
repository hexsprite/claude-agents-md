# Changelog

All notable changes to this plugin are documented here.

## [1.3.0] - 2026-04-29

### Added

- **Stage-level debug logging.** Set `CLAUDE_AGENTS_MD_DEBUG=1` to record per-stage timings (start, guards, git detection, scan strategy, scan completion, end) to `~/.claude/agents-md-debug.log`. Override the path with `CLAUDE_AGENTS_MD_DEBUG_LOG=<path>`. Useful when diagnosing whether this hook is contributing to `UserPromptSubmit` latency — `tail -f` the log while triggering a prompt and the slow stage will be obvious.

  ```bash
  CLAUDE_AGENTS_MD_DEBUG=1 claude
  tail -f ~/.claude/agents-md-debug.log
  ```

  Output format: `<timestamp>  pid=<n>  +<total>ms (Δ<step>ms)  <stage>  <details>`.

## [1.2.0] - 2026-04-29

### Changed

- **Scan honors `.gitignore` when inside a git repo.** The hook now uses `git ls-files --cached --others --exclude-standard` when `PROJECT_DIR` is inside a git working tree. This honors all `.gitignore` rules (including nested files and negation patterns) instead of relying on a hard-coded exclude list, and it's faster than walking the tree by hand. Tracked and untracked-but-not-ignored `AGENTS.md` files are both surfaced; gitignored ones are skipped.
- Non-git directories continue to use the existing `fd` / `find` fallback with the canned exclude list.

## [1.1.0] - 2026-04-29

### Changed

- **`CLAUDE.md` is now a symlink to `AGENTS.md` by default** instead of a text file containing `@AGENTS.md`. Single source of truth — edits to `AGENTS.md` flow through with zero duplication, and build watchers that key off `**/*.md` no longer see an extra real file.

### Added

- `CLAUDE_AGENTS_MD_NO_SYMLINK=1` — opt out of symlinks and use the original `@AGENTS.md` text file behavior. Automatic fallback when symlinks fail (Windows without Developer Mode, certain network/container mounts).
- Idempotency: when `CLAUDE.md` is already a symlink to `AGENTS.md`, the hook skips re-injection so the same content does not appear twice in context.
- `tests/hook-direct.test.ts` — direct shell-level tests for symlink and fallback behavior.

### Notes

- An existing non-symlink `CLAUDE.md` is never converted into a symlink. The hook still prepends `@AGENTS.md` to preserve any Claude-specific content the user has added below.

## [1.0.2] - 2026-04-29

### Fixed

- **Hook hangs when launched from `$HOME`.** The `scan-agents-md.sh` hook ran `find` / `fd` against `CLAUDE_PROJECT_DIR`, which caused multi-minute hangs on every `UserPromptSubmit` when Claude Code was started from the user's home directory (scanning `~/Library`, iCloud, mounted volumes, etc.). The hook now bails when `PROJECT_DIR` resolves to `$HOME` or filesystem root.
- **Pathological tree protection.** Scans are now wrapped in `timeout` (default 5s) so deep symlink loops, slow network mounts, or FUSE filesystems can no longer wedge the hook indefinitely.

### Added

- `CLAUDE_AGENTS_MD_ALLOW_HOME=1` — opt back into scanning `$HOME` for users who genuinely keep `AGENTS.md` at their home directory (e.g. dotfiles repo rooted there).
- `CLAUDE_AGENTS_MD_SCAN_TIMEOUT=<seconds>` — override the per-scan timeout (default `5`).
- `tests/scan-script.test.ts` — fast unit tests that exercise the hook script directly without spawning the Claude CLI.

## [1.0.1]

- Skip injection when `CLAUDE.md` is a symlink to `AGENTS.md`.
- Marketplace fixes.

## [1.0.0]

- Initial release: AGENTS.md support for Claude Code.
