// agents-md-vfs.js — Bun --preload helper that redirects in-process CLAUDE.md
// reads to a sibling AGENTS.md, so Claude Code picks up AGENTS.md without any
// symlink or file on disk. Zero dependencies, zero writes to disk.
//
// Loaded via BUN_OPTIONS="--require ~/.claude/agents-md-vfs.js" (see install.sh).
// Self-gating: only patches node:fs when running inside a compiled claude
// binary. Everywhere else (bun run, other CLIs sharing BUN_OPTIONS) it is a
// silent no-op.
"use strict";

// --- GATE ---------------------------------------------------------------
// Real claude (compiled single-file bun exe) looks like:
//   execPath = /Users/x/.local/share/claude/versions/2.1.208
//   argv[1]  = /$bunfs/root/src/entrypoints/cli.js
// basename(execPath) is the version number, not "claude" — never check it.
const argv1 = process.argv[1];
const isBunCompiledEntry = typeof argv1 === "string" && argv1.startsWith("/$bunfs/");
const isClaudeBinary = /claude/i.test(process.execPath);

if (isBunCompiledEntry && isClaudeBinary) {
  patch();
}

function patch() {
  const fs = require("fs");
  const path = require("path");

  const debug = !!process.env.AGENTS_MD_VFS_DEBUG;
  // AGENTS_MD_VFS_DEBUG=1 alone is enough: default to a per-process file in
  // /tmp so concurrent claude sessions never interleave into one log (the
  // thing that made cross-session reads look like they belonged here).
  // AGENTS_MD_VFS_LOG_PATH still overrides when you want a fixed path.
  const LOG_PATH =
    process.env.AGENTS_MD_VFS_LOG_PATH || `/tmp/agents-md-vfs-${process.pid}.log`;
  const LOG = debug
    ? (m) => {
        try {
          fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${m}\n`);
        } catch {
          // logging must never break the patched fs
        }
      }
    : () => {};

  // One-time stderr confirmation so you can see at a glance that debug mode
  // took effect and where it is writing — no need to guess the filename.
  if (debug) {
    try {
      console.error(
        `[agents-md-vfs] debug ON pid=${process.pid} cwd=${process.cwd()} log=${LOG_PATH}`
      );
    } catch {
      // never let the announce break the patched process
    }
  }

  // CANARY: set true the first time any patched fs entry point sees a
  // CLAUDE.md path (regardless of resolution outcome). If the helper loads
  // but this stays false for the whole process lifetime, Claude never asked
  // node:fs about CLAUDE.md — the signal a future claude moved to Bun.file.
  let claudeMdObserved = false;

  // Bind originals before patching anything — everything below reads/writes
  // through these, never through the patched fs.* exports.
  const orig = {
    readFileSync: fs.readFileSync.bind(fs),
    statSync: fs.statSync.bind(fs),
    existsSync: fs.existsSync.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
    access: fs.access.bind(fs),
    stat: fs.stat.bind(fs),
    readFile: fs.readFile.bind(fs),
    promisesReadFile: fs.promises.readFile.bind(fs.promises),
    promisesStat: fs.promises.stat.bind(fs.promises),
    promisesAccess: fs.promises.access.bind(fs.promises),
  };

  function isClaudeMdPath(p) {
    const match = typeof p === "string" && path.basename(p) === "CLAUDE.md";
    if (match) claudeMdObserved = true;
    return match;
  }

  function statOk(p) {
    try {
      orig.statSync(p);
      return true;
    } catch {
      return false;
    }
  }

  function realpathOrNull(p) {
    try {
      return orig.realpathSync(p);
    } catch {
      return null;
    }
  }

  // Classify a CLAUDE.md path P into one of the four resolution cases.
  // Returns { kind, twin } where kind is one of:
  //   "passthrough" | "path-swap" | "dedup" | "union-merge"
  function resolve(p) {
    const twin = path.join(path.dirname(p), "AGENTS.md");
    const agentsExists = statOk(twin);
    if (!agentsExists) return { kind: "passthrough", twin };

    const claudeExists = statOk(p);
    if (!claudeExists) return { kind: "path-swap", twin };

    const realP = realpathOrNull(p);
    const realTwin = realpathOrNull(twin);
    if (realP !== null && realP === realTwin) {
      return { kind: "dedup", twin };
    }
    return { kind: "union-merge", twin };
  }

  // Path used for metadata calls (existsSync/statSync/access): reports
  // presence of whichever file Claude should believe exists.
  function metadataPath(p) {
    const r = resolve(p);
    if (r.kind === "path-swap") return r.twin;
    return p; // passthrough / dedup / union-merge all resolve metadata at P (or P==twin)
  }

  const SEP = Buffer.from("\n\n");

  // Concatenate AGENTS.md bytes + "\n\n" + CLAUDE.md bytes as Buffers.
  function mergedBuffer(twin, p) {
    const a = orig.readFileSync(twin);
    const b = orig.readFileSync(p);
    return Buffer.concat([a, SEP, b]);
  }

  // Add byte length b to a stat's .size, honoring bigint-mode stats
  // (fs.statSync(p, { bigint: true })).
  function addToSize(size, extra) {
    return typeof size === "bigint" ? size + BigInt(extra) : size + extra;
  }

  // STAT-SIZE RISK (spec-flagged): a plain metadata redirect (statting P or
  // the twin) is correct for passthrough/dedup/path-swap, because served
  // content always matches that file's real bytes exactly. It is WRONG for
  // union-merge: content is a synthesized concatenation longer than either
  // source file, so a caller that stats CLAUDE.md and then reads exactly
  // that many bytes (fstat + fixed-length read, streaming, etc.) would
  // truncate the merge. Fix: for union-merge, stat both real files and
  // report their combined size on a real Stats object (preserves
  // isFile()/mode/mtime/etc. from the CLAUDE.md stat, only .size is fudged).
  function statSyncResolved(p, rest) {
    const r = resolve(p);
    if (r.kind === "path-swap") return orig.statSync(r.twin, ...rest);
    if (r.kind !== "union-merge") return orig.statSync(p, ...rest); // passthrough / dedup

    const stats = orig.statSync(p, ...rest);
    const twinStats = orig.statSync(r.twin, ...rest);
    stats.size = addToSize(addToSize(stats.size, SEP.length), twinStats.size);
    return stats;
  }

  // Read the resolved content for a CLAUDE.md path, honoring the requested
  // encoding the same way fs.readFileSync would (string if encoding given,
  // Buffer otherwise).
  function readResolved(p, options) {
    const r = resolve(p);
    const encoding =
      typeof options === "string" ? options : options && options.encoding;

    let buf;
    switch (r.kind) {
      case "path-swap":
        buf = orig.readFileSync(r.twin);
        break;
      case "union-merge":
        LOG(`union-merge ${r.twin} + ${p}`);
        buf = mergedBuffer(r.twin, p);
        break;
      case "passthrough":
      case "dedup":
      default:
        return orig.readFileSync(p, options);
    }
    return encoding ? buf.toString(encoding) : buf;
  }

  // --- sync: readFileSync, statSync, existsSync -------------------------

  fs.readFileSync = function (p, options) {
    if (!isClaudeMdPath(p)) return orig.readFileSync(p, options);
    return readResolved(p, options);
  };

  fs.statSync = function (p, ...rest) {
    if (!isClaudeMdPath(p)) return orig.statSync(p, ...rest);
    return statSyncResolved(p, rest);
  };

  fs.existsSync = function (p) {
    if (!isClaudeMdPath(p)) return orig.existsSync(p);
    return orig.existsSync(metadataPath(p));
  };

  // --- metadata: access (sync), fs.stat, fs.access (callback) -----------

  fs.accessSync = fs.accessSync
    ? (function (origAccessSync) {
        return function (p, ...rest) {
          if (!isClaudeMdPath(p)) return origAccessSync(p, ...rest);
          return origAccessSync(metadataPath(p), ...rest);
        };
      })(fs.accessSync.bind(fs))
    : fs.accessSync;

  fs.stat = function (p, options, callback) {
    if (!isClaudeMdPath(p)) return orig.stat(p, options, callback);

    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? undefined : options;
    const r = resolve(p);

    if (r.kind === "path-swap") return orig.stat(r.twin, opts, cb);
    if (r.kind !== "union-merge") return orig.stat(p, opts, cb); // passthrough / dedup

    // union-merge: same stat-size fix as statSyncResolved, async form.
    orig.stat(p, opts, (err, stats) => {
      if (err) return cb(err);
      orig.stat(r.twin, opts, (twinErr, twinStats) => {
        if (twinErr) return cb(twinErr);
        stats.size = addToSize(addToSize(stats.size, SEP.length), twinStats.size);
        cb(null, stats);
      });
    });
  };

  fs.access = function (p, ...rest) {
    if (!isClaudeMdPath(p)) return orig.access(p, ...rest);
    return orig.access(metadataPath(p), ...rest);
  };

  // --- content: fs.readFile (callback) -----------------------------------

  fs.readFile = function (p, options, callback) {
    if (!isClaudeMdPath(p)) return orig.readFile(p, options, callback);

    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? undefined : options;
    const r = resolve(p);

    if (r.kind === "passthrough" || r.kind === "dedup") {
      return orig.readFile(p, opts, cb);
    }
    if (r.kind === "path-swap") {
      return orig.readFile(r.twin, opts, cb);
    }
    // union-merge: no single underlying file holds the synthesized bytes,
    // so read both async and stitch, then hand back via the callback.
    const encoding = typeof opts === "string" ? opts : opts && opts.encoding;
    LOG(`union-merge (async) ${r.twin} + ${p}`);
    orig.readFile(r.twin, (aErr, aBuf) => {
      if (aErr) return cb(aErr);
      orig.readFile(p, (bErr, bBuf) => {
        if (bErr) return cb(bErr);
        const buf = Buffer.concat([aBuf, SEP, bBuf]);
        cb(null, encoding ? buf.toString(encoding) : buf);
      });
    });
  };

  // --- promises: fs.promises.readFile, .stat, .access --------------------

  fs.promises.readFile = async function (p, options) {
    if (!isClaudeMdPath(p)) return orig.promisesReadFile(p, options);

    const r = resolve(p);
    const encoding =
      typeof options === "string" ? options : options && options.encoding;

    if (r.kind === "passthrough" || r.kind === "dedup") {
      return orig.promisesReadFile(p, options);
    }
    if (r.kind === "path-swap") {
      return orig.promisesReadFile(r.twin, options);
    }
    LOG(`union-merge (promises) ${r.twin} + ${p}`);
    const [aBuf, bBuf] = await Promise.all([
      orig.promisesReadFile(r.twin),
      orig.promisesReadFile(p),
    ]);
    const buf = Buffer.concat([aBuf, SEP, bBuf]);
    return encoding ? buf.toString(encoding) : buf;
  };

  fs.promises.stat = async function (p, ...rest) {
    if (!isClaudeMdPath(p)) return orig.promisesStat(p, ...rest);

    const r = resolve(p);
    if (r.kind === "path-swap") return orig.promisesStat(r.twin, ...rest);
    if (r.kind !== "union-merge") return orig.promisesStat(p, ...rest); // passthrough / dedup

    // union-merge: same stat-size fix as statSyncResolved, promise form.
    const [stats, twinStats] = await Promise.all([
      orig.promisesStat(p, ...rest),
      orig.promisesStat(r.twin, ...rest),
    ]);
    stats.size = addToSize(addToSize(stats.size, SEP.length), twinStats.size);
    return stats;
  };

  fs.promises.access = function (p, ...rest) {
    if (!isClaudeMdPath(p)) return orig.promisesAccess(p, ...rest);
    return orig.promisesAccess(metadataPath(p), ...rest);
  };

  LOG(`vfs loaded pid=${process.pid} execPath=${process.execPath} argv1=${argv1}`);

  // CANARY (cont'd): report at process exit if the patch never saw a single
  // CLAUDE.md path. Sync-only work is safe in an 'exit' handler.
  if (debug) {
    process.on("exit", () => {
      if (!claudeMdObserved) {
        LOG(
          "canary: zero CLAUDE.md reads observed this process — claude may have moved off node:fs (e.g. Bun.file)"
        );
      }
    });
  }
}
