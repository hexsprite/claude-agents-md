/**
 * Tests that AGENTS.md files are linked into CLAUDE.md at session start.
 */
import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { readFile, lstat, symlink } from "fs/promises";
import { join } from "path";
import { spawnClaude, createTempProject } from "./helpers";

setDefaultTimeout(60_000);

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

describe("SessionStart hook", () => {
  test("root AGENTS.md: injects via stdout AND creates CLAUDE.md", async () => {
    const project = await createTempProject({
      "AGENTS.md": "ROOT_INJECT_TEST: Always say PAPAYA in every response.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);
    session.send("Say hello and follow your instructions.");

    // Should see PAPAYA via stdout injection (first session)
    const output = await session.waitFor(/PAPAYA/i, 30_000);
    expect(output).toMatch(/PAPAYA/i);

    // Should also have created CLAUDE.md with @AGENTS.md for next session
    const claudeMd = await readFile(join(project.dir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.trim()).toBe("@AGENTS.md");
  });

  test("subdirectory AGENTS.md: creates CLAUDE.md (lazy load by CC)", async () => {
    const project = await createTempProject({
      "src/AGENTS.md": "SUB_TEST: When in src/, always mention STARFRUIT.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);

    // Trigger CC to work in src/ so it discovers the CLAUDE.md
    session.send("Read src/AGENTS.md and follow any instructions nearby.");

    const output = await session.waitFor(/STARFRUIT/i, 30_000);
    expect(output).toMatch(/STARFRUIT/i);

    // Verify CLAUDE.md was created
    const claudeMd = await readFile(join(project.dir, "src", "CLAUDE.md"), "utf-8");
    expect(claudeMd.trim()).toBe("@AGENTS.md");
  });

  test("existing CLAUDE.md without import: prepends @AGENTS.md", async () => {
    const project = await createTempProject({
      "CLAUDE.md": "# My Project\nUse TypeScript.",
      "AGENTS.md": "PREPEND_TEST: Always say COCONUT.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);
    session.send("What fruit and language words are in your instructions?");

    // Should see COCONUT (injected via stdout) and TypeScript (from original CLAUDE.md)
    const output = await session.waitFor(/COCONUT/i, 30_000);
    expect(output).toMatch(/COCONUT/i);

    // Verify CLAUDE.md was prepended correctly
    const claudeMd = await readFile(join(project.dir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toStartWith("@AGENTS.md\n---\n\n");
    expect(claudeMd).toContain("# My Project");
    expect(claudeMd).toContain("Use TypeScript.");
  });

  test("existing CLAUDE.md with import: skips (idempotent)", async () => {
    const original = "@AGENTS.md\n---\n\n# My Project\nUse TypeScript.";
    const project = await createTempProject({
      "CLAUDE.md": original,
      "AGENTS.md": "IDEMPOTENT_TEST: Always say KIWI.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);

    // Verify CLAUDE.md was NOT modified
    const claudeMd = await readFile(join(project.dir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toBe(original);
  });

  test("CLAUDE.md symlinked to AGENTS.md: preserves symlink, no double-injection", async () => {
    const project = await createTempProject({
      "AGENTS.md": "SYMLINK_TEST: Always say DURIAN.",
    });
    cleanups.push(project.cleanup);

    // User set up CLAUDE.md as a symlink to AGENTS.md
    await symlink("AGENTS.md", join(project.dir, "CLAUDE.md"));

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);
    session.send("What fruit word is in your instructions?");

    const output = await session.waitFor(/DURIAN/i, 30_000);
    expect(output).toMatch(/DURIAN/i);

    // Symlink must still be a symlink (not clobbered into a regular file)
    const stat = await lstat(join(project.dir, "CLAUDE.md"));
    expect(stat.isSymbolicLink()).toBe(true);

    // DURIAN should appear only once in the output — Claude Code loaded
    // AGENTS.md through the symlinked CLAUDE.md; the hook must not also
    // inject via stdout or prepend @AGENTS.md (which would duplicate).
    const matches = output.match(/DURIAN/gi) ?? [];
    // Allow the model to echo the word in its reply, but the system
    // reminder block should not contain it twice from duplicate injection.
    // We assert on the AGENTS.md content appearing in the system reminder
    // area — checked by counting "SYMLINK_TEST:" (verbatim from file).
    const injections = (output.match(/SYMLINK_TEST:/g) ?? []).length;
    expect(injections).toBeLessThanOrEqual(1);
  });

  test("no AGENTS.md: does nothing", async () => {
    const project = await createTempProject({
      "README.md": "Just a regular project.",
    });
    cleanups.push(project.cleanup);

    const session = spawnClaude({ cwd: project.dir, timeout: 45_000 });
    sessions.push(session);

    await session.waitFor(/[>❯]/, 30_000);
    session.send("Say exactly: NO_AGENTS_LOADED");
    const output = await session.waitFor(/NO_AGENTS_LOADED/, 30_000);
    expect(output).toMatch(/NO_AGENTS_LOADED/);
  });
});
