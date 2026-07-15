# agents-md

> Makes Claude Code load `AGENTS.md` files — no per-project config needed.

Many AI coding tools use `AGENTS.md` for project-level instructions (Cursor, Codex, Windsurf, Continue.dev, etc.), but Claude Code only reads `CLAUDE.md`. agents-md bridges the gap so your cross-tool instructions just work.

**v2** replaces the v1 hook plugin with a Bun-preload virtual filesystem: a tiny helper injected into Claude's own process that redirects `CLAUDE.md` reads to `AGENTS.md` in-memory, with zero disk writes. No symlinks, no generated files, no hook re-scanning your tree on every prompt.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/hexsprite/claude-agents-md/main/install.sh | sh
```

This drops `agents-md-vfs.js` into `~/.claude/` and adds a small, marker-guarded `claude()` shell function to `~/.zshrc` and `~/.bashrc`. Open a new shell (or `source` your rc file), then start Claude Code in any project with an `AGENTS.md` file. Done.

> [!NOTE]
> fish is detected but not supported — the shell-function mechanism below doesn't translate cleanly to fish syntax. Fish users should stay on the [v1 plugin](#migrating-from-v1) for now.

## How it works

v2 has two parts: a shell function that gets the preload flag onto `claude`'s command line, and a `node:fs` monkeypatch that runs inside Claude's own process and serves `AGENTS.md` content wherever Claude asks for `CLAUDE.md`.

### The shell function (call-time merge)

Claude Code is a compiled Bun binary. Bun honors `BUN_OPTIONS` for injecting a `--require` preload script, but a Claude Code *plugin* has no way to set that env var for Claude's own process — so instead of a plugin, install.sh installs a shell function:

```sh
claude() {
  local _vfs="$HOME/.claude/agents-md-vfs.js"
  case " ${BUN_OPTIONS:-} " in
    *" --require $_vfs "*) ;;                                   # already present
    *) BUN_OPTIONS="${BUN_OPTIONS:+$BUN_OPTIONS }--require $_vfs" ;;
  esac
  BUN_OPTIONS="$BUN_OPTIONS" command claude "$@"
}
```

It reads whatever `BUN_OPTIONS` is already set at invocation time and appends the preload flag only if it's missing, then calls the real `claude` binary. This composes with anything else that sets `BUN_OPTIONS` (direnv, other tooling) instead of clobbering it, and it's idempotent — invoking `claude` repeatedly in the same shell never double-appends.

### The VFS helper (`agents-md-vfs.js`)

The helper self-gates before touching anything: it patches `fs` only if `process.argv[1]` is a string starting with `/$bunfs/` (a compiled single-file Bun executable) **and** `process.execPath` matches `/claude/i`. Any other Bun process — your own scripts, other CLIs on your machine — passes through completely untouched. (The gate deliberately does *not* check the binary's basename, which is a version number like `2.1.208`, not the string `claude`.)

Once gated in, it patches the `node:fs` surface Claude uses to check for and read `CLAUDE.md` — `readFileSync`, `statSync`, `existsSync`, the callback forms of `stat`/`access`/`readFile`, and the `fs.promises` equivalents — and only acts when the path argument's basename is exactly `CLAUDE.md`. Everything else (fd, `Buffer`, or `URL` path arguments; any other filename) passes straight through to the real `fs`.

For a `CLAUDE.md` read at path `P` in directory `D`, with twin `A = D/AGENTS.md`:

| Situation | Behavior |
|---|---|
| No `AGENTS.md` next to it | **Passthrough.** Real `fs` behavior, including a real `ENOENT` if `CLAUDE.md` doesn't exist either. |
| `AGENTS.md` exists, `CLAUDE.md` doesn't | **Path-swap.** Claude is told `CLAUDE.md` exists (metadata calls report a match) and content reads return `AGENTS.md`'s bytes. |
| Both exist, and `CLAUDE.md` is a symlink to `AGENTS.md` | **Symlink dedup.** Same file on disk (`realpathSync` resolves to the same target) — passthrough, served once, no duplication. |
| Both exist as distinct files | **Union-merge.** Content returned is `<AGENTS.md bytes>` + `\n\n` + `<CLAUDE.md bytes>` — `AGENTS.md` as the shared base every tool reads, your `CLAUDE.md` as a Claude-only overlay that wins on conflicts because it's appended last. |

This applies wherever Claude looks — project root, subdirectories, `~/.claude/CLAUDE.md` — with no special-casing by depth. Only the content methods (`readFileSync`, `readFile`, `promises.readFile`) return synthesized bytes; the metadata methods (`statSync`, `access`, `stat`, `existsSync`) just report existence for whichever file is now "real" in Claude's eyes, so Claude believes `CLAUDE.md` exists and proceeds to read it.

Encoding is honored the same way `fs` normally does it: pass an encoding and you get a string back; omit it and you get a `Buffer`. Merged or swapped content is assembled as `Buffer`s first, then decoded once at the end if a string was requested.

Debug logging is off by default and gated behind an env var — see [Configuration](#configuration). If the helper is loaded but a debug run shows zero `CLAUDE.md` activity for a real session, that's the signal a future Claude release has moved off `node:fs` reads (e.g. to `Bun.file`); the helper isn't currently wired to intercept `Bun.file`, and that gap gets noted in the log rather than silently missed.

### What this means for your project

Nothing is written to disk. There's no `CLAUDE.md` symlink to gitignore, no generated file to review in diffs, no hook re-walking your tree on every message. Drop an `AGENTS.md` anywhere Claude would look for a `CLAUDE.md`, and it's just there — for every session, starting with the first one.

```
my-project/
├── AGENTS.md              # served as CLAUDE.md, in-memory, every session
├── src/
│   └── AGENTS.md           # same, for src/
└── lib/
    ├── CLAUDE.md            # your Claude-only instructions
    └── AGENTS.md            # shared instructions — merged in as the base
```

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/hexsprite/claude-agents-md/main/uninstall.sh | sh
```

Strips the marker-guarded block from `~/.zshrc` and `~/.bashrc` and removes `~/.claude/agents-md-vfs.js`. Nothing else is touched — the installer never wrote anywhere else, so there's nothing else to clean up. Open a new shell to drop the function.

## Migrating from v1

If you have the v1 plugin installed (`agents-md@hexsprite`), install v2 alongside it, confirm it's working, then run:

```
/plugin uninstall agents-md@hexsprite
```

That's a recommendation, not a requirement — the two can coexist safely, just redundantly:

- Any `CLAUDE.md → AGENTS.md` symlinks v1 already created are harmless under v2. The helper's symlink-dedup branch detects them via `realpathSync` and passes through without merging, so nothing gets duplicated.
- A v1-generated `CLAUDE.md` containing `@AGENTS.md` (text-file fallback mode) still works fine on its own — that's Claude Code's native `@import` resolution, unrelated to whether v2 is installed.
- v2's installer never deletes or migrates v1 state. It only adds the shell function and the helper file — nothing it does can conflict with what v1 left behind.

v1 (the hook-based plugin — scan, symlink-or-inject, `UserPromptSubmit` re-scan) is frozen on the [`v1` branch](https://github.com/hexsprite/claude-agents-md/tree/v1) for anyone who can't use the shell-function approach (fish shells, locked-down environments where a plugin is the only installable surface). It receives no further feature work; see that branch's README for its own install/config docs.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENTS_MD_VFS_DEBUG` | unset | Set to `1` to log helper activity (gate decisions, which of the four branches a given `CLAUDE.md` read took) to a per-process file `/tmp/agents-md-vfs-<pid>.log`, and print a one-line `[agents-md-vfs] debug ON …` confirmation to stderr at startup. Per-process default means concurrent sessions never interleave into one log. |
| `AGENTS_MD_VFS_LOG_PATH` | `/tmp/agents-md-vfs-<pid>.log` | Override the debug log path with a fixed filename (only meaningful when `AGENTS_MD_VFS_DEBUG=1`). |
| `AGENTS_MD_VFS_SRC` | unset | **install.sh only.** Local path to `agents-md-vfs.js` to copy instead of curling the published one — for testing installer changes from a clone without publishing first. |

### Verify it's working

Start a Claude Code session in a directory with an `AGENTS.md` and ask what's in its project instructions — it should reflect the `AGENTS.md` content as if it were `CLAUDE.md`.

To confirm the helper itself loaded, enable `AGENTS_MD_VFS_DEBUG=1`. It logs every gate decision to a per-pid file and, at startup, prints `[agents-md-vfs] debug ON pid=… cwd=… log=…` to stderr. Claude's TUI clears the screen on launch, so that line flashes past — instead of chasing the pid, tail the stable pointer that every debug session repoints at its own log:

```bash
tail -F /tmp/agents-md-vfs-latest.log   # -F re-opens when a new session repoints it
```

Then start `AGENTS_MD_VFS_DEBUG=1 claude` in another pane and watch the reads stream in.

## Running tests

```bash
bun install
bun test
```

> [!IMPORTANT]
> Some suites spawn real Claude sessions via Bun's [Terminal (PTY) API](https://bun.sh/docs/api/spawn#terminal-pty-support) and make API calls. Budget for API credit usage and slower runs on those.

## Project structure

```
claude-agents-md/
├── agents-md-vfs.js        # the preload helper (v2) — gate, redirect, merge
├── install.sh                # curl-installable installer (v2)
├── uninstall.sh                # matching uninstaller (v2)
├── experiments/v2-vfs/          # original prototypes, kept as reference
├── hooks/                        # v1 hook — frozen, see the `v1` branch
├── tests/
│   ├── helpers.ts                 # PTY test harness (Bun.Terminal)
│   └── *.test.ts
└── package.json
```
