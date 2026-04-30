# agents-md

> Claude Code plugin that loads `AGENTS.md` files — no per-project config needed.

Many AI coding tools use `AGENTS.md` for project-level instructions (Cursor, Codex, Windsurf, Continue.dev, etc.), but Claude Code only reads `CLAUDE.md`. This plugin bridges the gap so your cross-tool instructions just work.

## Install

```bash
/plugin marketplace add hexsprite/claude-agents-md
/plugin install agents-md@hexsprite
```

Then start a Claude Code session in any project with an `AGENTS.md` file. Done.

Or test locally from a clone:

```bash
claude --plugin-dir /path/to/claude-agents-md
```

> [!TIP]
> Use `/reload-plugins` inside a running session to pick up plugin changes without restarting.

## How it works

For each `AGENTS.md` found in your project tree, the plugin:

1. **Creates a `CLAUDE.md` symlink** pointing at `AGENTS.md` in the same directory (falling back to a `@AGENTS.md` text file on platforms that can't symlink), or prepends `@AGENTS.md` to an existing `CLAUDE.md` that doesn't already have it
2. **Injects the content via stdout** for the current session (since Claude Code reads `CLAUDE.md` files before hooks fire on the first run)

This means:
- **First session**: Content is injected directly. The generated `CLAUDE.md` files take effect from the next session onward.
- **Subsequent sessions**: Claude Code natively reads the `CLAUDE.md` → `@AGENTS.md` imports. The plugin only injects truly new files.
- **Mid-session**: New `AGENTS.md` files (e.g., after a `git pull`) are detected and injected on your next prompt.

### What gets created

If your project has an `AGENTS.md` but no `CLAUDE.md`:

```
CLAUDE.md -> AGENTS.md   (relative symlink created by plugin)
AGENTS.md                (your file, untouched)
```

The plugin prefers a symlink because it keeps a single source of truth — edits to `AGENTS.md` show up through `CLAUDE.md` with zero duplication, and build watchers that key off `**/*.md` won't see an extra real file.

If your platform can't create symlinks (Windows without Developer Mode, certain network mounts) or you opt out with `CLAUDE_AGENTS_MD_NO_SYMLINK=1`, the plugin falls back to a `@AGENTS.md` text file:

```
CLAUDE.md  (contains: @AGENTS.md)
AGENTS.md  (your file, untouched)
```

If a `CLAUDE.md` already exists, the import is prepended — the plugin never converts an existing file into a symlink:

```markdown
@AGENTS.md
---

# Your existing CLAUDE.md content
...
```

> [!NOTE]
> When the fallback text file is used, `CLAUDE.md` is a normal file you can edit, commit, or gitignore — you can add Claude-specific instructions below the `@AGENTS.md` import. When a symlink is used and you later want to add Claude-only content, replace the symlink with a text file and the plugin will leave it alone.

### Hook events

| Event | When | Purpose |
|---|---|---|
| **SessionStart** | Session begins | Initial scan — link and inject all `AGENTS.md` files |
| **UserPromptSubmit** | Every prompt | Re-scan for new `AGENTS.md` files added mid-session |

A temp file tracks which `AGENTS.md` files have been injected this session to avoid duplicates.

### Scan strategy

The plugin picks the cheapest correct walker for the current tree, in order:

1. **`git ls-files`** when `CLAUDE_PROJECT_DIR` is inside a git working tree. Honors all `.gitignore` rules — including nested `.gitignore` files and negation patterns — and surfaces both tracked and untracked-but-not-ignored `AGENTS.md` files. Fast even on large monorepos because it reads the index instead of walking the tree.
2. **[`fd`](https://github.com/sharkdp/fd)** when not in a git repo. Honors `.gitignore` by default and respects the canned exclude list below.
3. **`find`** as a final fallback when neither is available.

For the `fd` and `find` paths, the canned exclude list is `node_modules .git vendor dist build .next .cache __pycache__ .venv`.

### Safety guards

The plugin runs on every `UserPromptSubmit`, so a slow walk can stall every prompt. Two guards keep this honest:

- **`$HOME` / root bail.** If `CLAUDE_PROJECT_DIR` resolves to your home directory or filesystem root, the hook exits immediately. Scanning `~` traverses `Library`, iCloud, and mounted volumes — minutes per prompt. AGENTS.md scanning is meant for project trees, not `$HOME`.
- **Per-scan timeout** (default 5s) wraps `fd` / `find` / `git ls-files`. Pathological trees (network mounts, FUSE, deep symlink loops) can no longer wedge the hook indefinitely.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_AGENTS_MD_NO_SYMLINK` | `0` | Set to `1` to disable the `CLAUDE.md → AGENTS.md` symlink and use a `@AGENTS.md` text file instead. Auto-applied when symlinks fail. |
| `CLAUDE_AGENTS_MD_ALLOW_HOME` | `0` | Set to `1` to opt back into scanning `$HOME` (e.g. dotfiles repo rooted at `$HOME`). |
| `CLAUDE_AGENTS_MD_SCAN_TIMEOUT` | `5` | Per-scan timeout in seconds for the `fd` / `find` / `git ls-files` step. |
| `CLAUDE_AGENTS_MD_DEBUG` | `0` | Set to `1` to log per-stage timings (start, guards, git detection, scan strategy, scan completion, end). |
| `CLAUDE_AGENTS_MD_DEBUG_LOG` | `~/.claude/agents-md-debug.log` | Override the debug log path. |

### Diagnosing UserPromptSubmit lag

If you suspect this hook is contributing to prompt-submit latency, enable stage logging:

```bash
export CLAUDE_AGENTS_MD_DEBUG=1
claude
# in another terminal:
tail -f ~/.claude/agents-md-debug.log
```

Each prompt produces a handful of timestamped lines like:

```
2026-04-29 20:53:06  pid=93501  +  126ms (Δ  41ms)  git    root=/Users/me/myrepo
2026-04-29 20:53:06  pid=93501  +  156ms (Δ  30ms)  scan   strategy=git-ls-files  root=/Users/me/myrepo
2026-04-29 20:53:06  pid=93501  +  217ms (Δ  61ms)  scan   done count=3
2026-04-29 20:53:06  pid=93501  +  333ms (Δ 116ms)  end    injected=3
```

The slow stage will be obvious. If total time is well under a second, the lag isn't coming from this plugin.

## Usage

Drop an `AGENTS.md` file in your project root (or any subdirectory) and start a Claude Code session. That's it.

```
my-project/
├── AGENTS.md            # loaded at session start
├── src/
│   └── AGENTS.md        # loaded when Claude works in src/
└── lib/
    ├── CLAUDE.md        # existing file — @AGENTS.md prepended
    └── AGENTS.md
```

### Verify it's working

Toggle verbose mode (`Ctrl+O`) to see hook output:

```
agents-md: injected 2 new AGENTS.md file(s)
```

## Running tests

Tests drive the real Claude CLI through Bun's native [Terminal (PTY) API](https://bun.sh/docs/api/spawn#terminal-pty-support), spawning interactive sessions and asserting that `AGENTS.md` content reaches Claude's context.

```bash
bun install
bun test
```

> [!IMPORTANT]
> Tests spawn real Claude sessions and make API calls. Each run takes ~60s and consumes API credits.

Run a specific suite:

```bash
bun run test:session      # SessionStart hook tests
bun run test:filechange   # Mid-session detection tests
```

### What's tested

- Root-level `AGENTS.md` injected at session start
- Subdirectory `AGENTS.md` discovered and `CLAUDE.md` created
- Existing `CLAUDE.md` gets `@AGENTS.md` prepended (with `---` separator)
- Idempotent — already-linked files are not modified
- No-op when no `AGENTS.md` exists
- New root `AGENTS.md` created mid-session is detected on next prompt
- New subdirectory `AGENTS.md` created mid-session is detected on next prompt
- Already-injected files are not re-injected on subsequent prompts

## Project structure

```
claude-agents-md/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── hooks/
│   ├── hooks.json           # SessionStart + UserPromptSubmit config
│   └── scan-agents-md.sh   # Find, link, inject, deduplicate
├── tests/
│   ├── helpers.ts           # PTY test harness (Bun.Terminal)
│   ├── session-start.test.ts
│   └── file-changed.test.ts
└── package.json
```
