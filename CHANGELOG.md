# Changelog

All notable changes to this plugin are documented here.

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
