/**
 * Tests for agents-md-vfs.js — the Bun --preload helper that redirects
 * in-process CLAUDE.md reads to a sibling AGENTS.md.
 *
 * The helper only patches node:fs when BOTH gate conditions hold:
 *   - process.argv[1] starts with "/$bunfs/" (compiled single-file bun exe)
 *   - process.execPath matches /claude/i
 *
 * A plain `bun run fixture.js` can never satisfy the first condition, so we
 * exercise the real patched code paths by compiling a tiny fixture
 * (tests/fixtures/vfs/read-claude-md.js) with `bun build --compile` into a
 * binary whose path contains "claude", then running it with
 * BUN_OPTIONS="--require agents-md-vfs.js" against temp directories.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtemp, rm, symlink, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createTempProject } from "./helpers";

setDefaultTimeout(30_000);

const VFS_PATH = join(import.meta.dir, "..", "agents-md-vfs.js");
const FIXTURE_SRC = join(import.meta.dir, "fixtures", "vfs", "read-claude-md.js");
const NO_TOUCH_FIXTURE_SRC = join(import.meta.dir, "fixtures", "vfs", "no-touch.js");

let workDir: string;
/** Path contains "claude" so the helper's execPath gate fires. */
let compiledClaudeBin: string;
/** Compiled from a fixture that never touches a CLAUDE.md path — for the exit-canary test. */
let compiledNoTouchBin: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "agents-md-vfs-build-"));
  compiledClaudeBin = join(workDir, "claude-fixture-bin");
  compiledNoTouchBin = join(workDir, "claude-no-touch-bin");

  for (const [src, outfile] of [
    [FIXTURE_SRC, compiledClaudeBin],
    [NO_TOUCH_FIXTURE_SRC, compiledNoTouchBin],
  ] as const) {
    const build = Bun.spawnSync(["bun", "build", "--compile", src, "--outfile", outfile], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) {
      throw new Error(
        `bun build --compile failed (exit ${build.exitCode}):\n${build.stderr.toString()}`
      );
    }
  }
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups) await fn();
  cleanups = [];
});

interface FixtureResult {
  argv1: string;
  execPath: string;
  existsSync: boolean;
  readFileSyncUtf8?: string;
  readFileSyncUtf8IsString?: boolean;
  readFileSyncUtf8Error?: string;
  readFileSyncBufferIsBuffer?: boolean;
  readFileSyncBufferContent?: string;
  readFileSyncBufferError?: string;
  readFileCallback: string | { error: string };
  statCallback: string | { error: string };
  statCallbackSize: number | { error: string };
  statSyncSize?: number;
  statSyncSizeError?: string;
  promisesStatSize?: number;
  promisesStatSizeError?: string;
  promisesReadFile?: string;
  promisesReadFileError?: string;
}

/** Run the compiled ("claude") fixture binary with the vfs preloaded. */
async function runCompiledFixture(dir: string): Promise<FixtureResult> {
  return runFixture(compiledClaudeBin, [dir]);
}

/** Run the fixture source directly through plain `bun` — gate stays off. */
async function runUncompiledFixture(dir: string): Promise<FixtureResult> {
  return runFixture("bun", [FIXTURE_SRC, dir]);
}

async function runFixture(bin: string, args: string[]): Promise<FixtureResult> {
  const proc = Bun.spawn([bin, ...args], {
    env: { ...process.env, BUN_OPTIONS: `--require ${VFS_PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`fixture exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return JSON.parse(stdout.trim());
}

describe("agents-md-vfs.js", () => {
  test("gate OFF: plain `bun` process leaves fs untouched (real ENOENT on missing CLAUDE.md)", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
    });
    cleanups.push(project.cleanup);

    const result = await runUncompiledFixture(project.dir);

    // argv[1] must NOT start with /$bunfs/ for a plain `bun <file>` run —
    // confirms this test actually exercises the gate-off path, not a fluke.
    expect(result.argv1.startsWith("/$bunfs/")).toBe(false);
    expect(result.existsSync).toBe(false);
    expect(result.readFileSyncUtf8Error).toBe("ENOENT");
    expect(result.promisesReadFileError).toBe("ENOENT");
    expect((result.readFileCallback as { error: string }).error).toBe("ENOENT");
  });

  test("passthrough: no AGENTS.md -> real CLAUDE.md content served untouched", async () => {
    const project = await createTempProject({
      "CLAUDE.md": "CLAUDE ONLY CONTENT",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    expect(result.existsSync).toBe(true);
    expect(result.readFileSyncUtf8).toBe("CLAUDE ONLY CONTENT");
    expect(result.readFileSyncBufferContent).toBe("CLAUDE ONLY CONTENT");
    expect(result.promisesReadFile).toBe("CLAUDE ONLY CONTENT");
    expect(result.readFileCallback).toBe("CLAUDE ONLY CONTENT");
  });

  test("passthrough: neither file present -> real ENOENT even inside compiled claude binary", async () => {
    const project = await createTempProject({});
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    expect(result.existsSync).toBe(false);
    expect(result.readFileSyncUtf8Error).toBe("ENOENT");
  });

  test("path-swap: only AGENTS.md present -> its content served for a CLAUDE.md read", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS ONLY CONTENT",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    expect(result.existsSync).toBe(true);
    expect(result.readFileSyncUtf8).toBe("AGENTS ONLY CONTENT");
    expect(result.readFileSyncBufferContent).toBe("AGENTS ONLY CONTENT");
    expect(result.promisesReadFile).toBe("AGENTS ONLY CONTENT");
    expect(result.readFileCallback).toBe("AGENTS ONLY CONTENT");
    expect(result.statCallback).toBe("ok");
  });

  test("union-merge: both present (distinct files) -> AGENTS bytes then CLAUDE bytes, joined by \\n\\n", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
      "CLAUDE.md": "CLAUDE RULES",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    const expected = "AGENTS RULES\n\nCLAUDE RULES";
    expect(result.existsSync).toBe(true);
    expect(result.readFileSyncUtf8).toBe(expected);
    expect(result.readFileSyncBufferContent).toBe(expected);
    expect(result.promisesReadFile).toBe(expected);
    expect(result.readFileCallback).toBe(expected);
  });

  // Regression test for the stat-size truncation risk called out in the
  // redirect spec (claude-agents-md-6l7.2): a caller that stats CLAUDE.md
  // then reads exactly that many bytes (fstat + fixed-length read,
  // streaming, etc. — not fs.readFileSync, which we fully control) would
  // truncate a union-merge if statSync/stat/promises.stat reported
  // CLAUDE.md's real (smaller) size instead of the synthesized size.
  test("union-merge: statSync/fs.stat/promises.stat report the synthesized (merged) size, not CLAUDE.md's real size", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
      "CLAUDE.md": "CLAUDE RULES",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    const expectedSize = Buffer.byteLength("AGENTS RULES\n\nCLAUDE RULES");
    // Sanity: the merged size must differ from CLAUDE.md's own real size —
    // otherwise this test wouldn't actually catch the truncation bug.
    expect(expectedSize).not.toBe(Buffer.byteLength("CLAUDE RULES"));

    expect(result.statSyncSize).toBe(expectedSize);
    expect(result.statCallbackSize).toBe(expectedSize);
    expect(result.promisesStatSize).toBe(expectedSize);
  });

  test("symlink dedup: CLAUDE.md -> AGENTS.md served once (not doubled)", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
    });
    cleanups.push(project.cleanup);

    await symlink("AGENTS.md", join(project.dir, "CLAUDE.md"));

    const result = await runCompiledFixture(project.dir);

    expect(result.existsSync).toBe(true);
    expect(result.readFileSyncUtf8).toBe("AGENTS RULES");
    expect(result.readFileSyncUtf8).not.toContain("AGENTS RULES\n\nAGENTS RULES");
    expect(result.promisesReadFile).toBe("AGENTS RULES");
  });

  test("encoding: readFileSync with 'utf8' returns a string, without encoding returns a Buffer", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
      "CLAUDE.md": "CLAUDE RULES",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    expect(result.readFileSyncUtf8IsString).toBe(true);
    expect(typeof result.readFileSyncUtf8).toBe("string");
    expect(result.readFileSyncBufferIsBuffer).toBe(true);
  });

  test("gate ON sanity: compiled fixture reports the /$bunfs/ argv1 and a claude-containing execPath", async () => {
    const project = await createTempProject({
      "AGENTS.md": "AGENTS RULES",
    });
    cleanups.push(project.cleanup);

    const result = await runCompiledFixture(project.dir);

    expect(result.argv1.startsWith("/$bunfs/")).toBe(true);
    expect(/claude/i.test(result.execPath)).toBe(true);
  });

  // Regression tests for the exit-time canary called out in the spec: "If
  // the helper loads but observes zero CLAUDE.md reads in the process, that
  // is the signal a future claude moved to Bun.file — note it in the debug
  // log." The original implementation gated all debug logging behind
  // AGENTS_MD_VFS_DEBUG but never actually tracked or reported this signal.
  describe("exit canary", () => {
    async function runWithDebugLog(
      bin: string,
      args: string[]
    ): Promise<{ exitCode: number; log: string }> {
      const logPath = join(workDir, `canary-${Math.random().toString(36).slice(2)}.log`);
      const proc = Bun.spawn([bin, ...args], {
        env: {
          ...process.env,
          BUN_OPTIONS: `--require ${VFS_PATH}`,
          AGENTS_MD_VFS_DEBUG: "1",
          AGENTS_MD_VFS_LOG_PATH: logPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const log = await Bun.file(logPath)
        .text()
        .catch(() => "");
      return { exitCode, log };
    }

    test("logs the canary when the process never touches a CLAUDE.md path", async () => {
      const { exitCode, log } = await runWithDebugLog(compiledNoTouchBin, []);

      expect(exitCode).toBe(0);
      expect(log).toContain("canary: zero CLAUDE.md reads observed");
    });

    test("does NOT log the canary when the process reads a CLAUDE.md path", async () => {
      const project = await createTempProject({
        "AGENTS.md": "AGENTS RULES",
        "CLAUDE.md": "CLAUDE RULES",
      });
      cleanups.push(project.cleanup);

      const { exitCode, log } = await runWithDebugLog(compiledClaudeBin, [project.dir]);

      expect(exitCode).toBe(0);
      expect(log).not.toContain("canary: zero CLAUDE.md reads observed");
      expect(log).toContain("vfs loaded");
    });
  });

  // AGENTS_MD_VFS_DEBUG=1 alone must enable logging (no AGENTS_MD_VFS_LOG_PATH
  // required) to a per-process /tmp file, and announce on stderr that debug is
  // on plus where it writes. Regression for the shared-log confusion where
  // concurrent sessions interleaved into one fixed /tmp/agents-md-vfs.log.
  describe("debug announce + default per-pid log", () => {
    test("DEBUG=1 without LOG_PATH announces on stderr and writes /tmp/agents-md-vfs-<pid>.log", async () => {
      const proc = Bun.spawn([compiledNoTouchBin], {
        env: {
          ...process.env,
          BUN_OPTIONS: `--require ${VFS_PATH}`,
          AGENTS_MD_VFS_DEBUG: "1",
          AGENTS_MD_VFS_LOG_PATH: "", // explicitly unset — exercise the default
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toContain("[agents-md-vfs] debug ON");

      const m = stderr.match(/log=(\/tmp\/agents-md-vfs-\d+\.log)/);
      expect(m).not.toBeNull();
      const logPath = m![1];
      const log = await Bun.file(logPath)
        .text()
        .catch(() => "");
      expect(log).toContain("vfs loaded");
      await rm(logPath, { force: true });
    });

    // TUI clears the screen on startup, so the stderr announce (and the pid in
    // it) flashes past. The stable /tmp/agents-md-vfs-latest.log symlink is the
    // durable way to `tail -F` the current session's log without the pid.
    test("repoints /tmp/agents-md-vfs-latest.log at the active per-pid log", async () => {
      const proc = Bun.spawn([compiledNoTouchBin], {
        env: {
          ...process.env,
          BUN_OPTIONS: `--require ${VFS_PATH}`,
          AGENTS_MD_VFS_DEBUG: "1",
          AGENTS_MD_VFS_LOG_PATH: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode).toBe(0);

      const logPath = stderr.match(/log=(\/tmp\/agents-md-vfs-\d+\.log)/)![1];
      const linkTarget = await realpath("/tmp/agents-md-vfs-latest.log").catch(
        () => ""
      );
      expect(linkTarget).toBe(await realpath(logPath));
      await rm(logPath, { force: true });
    });
  });
});
