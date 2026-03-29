/**
 * Tests that AGENTS.md files created mid-session are picked up on next prompt.
 * Uses UserPromptSubmit hook to scan for new AGENTS.md files.
 */
import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { spawnClaude, createTempProject } from "./helpers";

setDefaultTimeout(90_000);

let cleanups: Array<() => Promise<void>> = [];
let sessions: Array<{ kill: () => void; exited: Promise<number> }> = [];

afterEach(async () => {
  for (const s of sessions) {
    s.kill();
    await s.exited;
  }
  sessions = [];
  for (const fn of cleanups) await fn();
  cleanups = [];
});

describe("Mid-session AGENTS.md detection", () => {
  test("new root AGENTS.md picked up on next prompt", async () => {
    const project = await createTempProject({
      "README.md": "Empty project to start.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 60_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);

    // Create AGENTS.md from outside the session
    await writeFile(
      join(project.dir, "AGENTS.md"),
      "MID_SESSION_ROOT: You must end every response with YARR.",
      "utf-8"
    );

    // Next prompt triggers UserPromptSubmit scan
    session.send("Say hello and follow any new instructions.");

    const output = await session.waitFor(/YARR/i, 30_000);
    expect(output).toMatch(/YARR/i);

    // Verify CLAUDE.md was created
    const claudeMd = await readFile(join(project.dir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.trim()).toBe("@AGENTS.md");
  });

  test("new subdirectory AGENTS.md picked up on next prompt", async () => {
    const project = await createTempProject({
      "README.md": "Project with no agents files yet.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 60_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);

    // Create a subdirectory with AGENTS.md mid-session
    const subDir = join(project.dir, "src");
    await mkdir(subDir, { recursive: true });
    await writeFile(
      join(subDir, "AGENTS.md"),
      "MID_SESSION_SUB: Always mention SUBMARINE.",
      "utf-8"
    );

    // Next prompt triggers scan
    session.send("Follow any new instructions and say hello.");

    const output = await session.waitFor(/SUBMARINE/i, 30_000);
    expect(output).toMatch(/SUBMARINE/i);

    // Verify CLAUDE.md was created in subdirectory
    const claudeMd = await readFile(join(subDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.trim()).toBe("@AGENTS.md");
  });

  test("already-injected files are not re-injected on subsequent prompts", async () => {
    const project = await createTempProject({
      "AGENTS.md": "DEDUP_TEST: Say MANGO exactly once.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 60_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);

    // First prompt — should inject AGENTS.md
    session.send("What fruit were you told to mention?");
    await session.waitFor(/MANGO/i, 30_000);

    // Second prompt — scan runs again but should skip (already tracked)
    session.send("Say hello.");
    // Just verify it doesn't error out — the scan should be a no-op
    await session.waitFor(/[Hh]ello/, 30_000);
  });
});
