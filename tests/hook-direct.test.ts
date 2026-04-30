/**
 * Direct shell-level tests of the scan-agents-md hook.
 * Avoids spawning the full Claude CLI — fast and deterministic for behaviors
 * that only exercise the hook's file-creation logic.
 */
import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { lstat, readlink, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createTempProject } from "./helpers";

setDefaultTimeout(15_000);

const HOOK = join(import.meta.dir, "..", "hooks", "scan-agents-md.sh");

async function runHook(
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", HOOK], {
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups) await fn();
  cleanups = [];
});

describe("scan-agents-md.sh (direct)", () => {
  test("default: creates CLAUDE.md as symlink to AGENTS.md", async () => {
    const project = await createTempProject({
      "AGENTS.md": "root rules",
    });
    cleanups.push(project.cleanup);

    const { exitCode } = await runHook(project.dir);
    expect(exitCode).toBe(0);

    const claudeMdPath = join(project.dir, "CLAUDE.md");
    const stat = await lstat(claudeMdPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await readlink(claudeMdPath)).toBe("AGENTS.md");
  });

  test("CLAUDE_AGENTS_MD_NO_SYMLINK=1: falls back to @AGENTS.md text file", async () => {
    const project = await createTempProject({
      "AGENTS.md": "root rules",
    });
    cleanups.push(project.cleanup);

    const { exitCode } = await runHook(project.dir, {
      CLAUDE_AGENTS_MD_NO_SYMLINK: "1",
    });
    expect(exitCode).toBe(0);

    const claudeMdPath = join(project.dir, "CLAUDE.md");
    const stat = await lstat(claudeMdPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    const contents = await readFile(claudeMdPath, "utf-8");
    expect(contents.trim()).toBe("@AGENTS.md");
  });

  test("existing non-@AGENTS.md CLAUDE.md: prepends @AGENTS.md (not replaced by symlink)", async () => {
    const project = await createTempProject({
      "AGENTS.md": "shared rules",
      "CLAUDE.md": "# Claude-specific notes\nUse TypeScript.",
    });
    cleanups.push(project.cleanup);

    const { exitCode } = await runHook(project.dir);
    expect(exitCode).toBe(0);

    const claudeMdPath = join(project.dir, "CLAUDE.md");
    const stat = await lstat(claudeMdPath);
    expect(stat.isSymbolicLink()).toBe(false);
    const contents = await readFile(claudeMdPath, "utf-8");
    expect(contents).toStartWith("@AGENTS.md\n---\n\n");
    expect(contents).toContain("Use TypeScript.");
  });

  test("idempotent on repeat runs: symlink preserved", async () => {
    const project = await createTempProject({
      "AGENTS.md": "rules",
    });
    cleanups.push(project.cleanup);

    await runHook(project.dir);
    await runHook(project.dir);

    const claudeMdPath = join(project.dir, "CLAUDE.md");
    const stat = await lstat(claudeMdPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await readlink(claudeMdPath)).toBe("AGENTS.md");
  });
});
