// Fixture used by tests/vfs.test.ts to exercise the exit-time canary log.
//
// Deliberately never reads, stats, or checks existence of any CLAUDE.md
// path — when compiled to a "claude"-path binary and run with the vfs
// preloaded, isClaudeMdPath() should never fire, so the canary should log
// "zero CLAUDE.md reads observed" at process exit (when debug is enabled).
"use strict";

console.log(JSON.stringify({ ok: true }));
