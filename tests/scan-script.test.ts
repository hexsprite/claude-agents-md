/**
 * Direct unit tests for hooks/scan-agents-md.sh — fast, no Claude CLI spawn.
 *
 * Covers the safety guards added to prevent the hook from scanning $HOME or
 * filesystem root, which previously caused multi-minute hangs on every
 * UserPromptSubmit when claude was launched from ~.
 */
import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

setDefaultTimeout(15_000);

const SCRIPT = join(import.meta.dir, "..", "hooks", "scan-agents-md.sh");

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups) await fn();
  cleanups = [];
});

async function makeFakeHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "agents-md-fake-home-"));
  // Plant an AGENTS.md at the fake $HOME root — if the bail logic fails,
  // the script would emit it via stdout and we'd notice.
  await writeFile(join(home, "AGENTS.md"), "HOME_BAIL_TEST: must not be injected.");
  return {
    home,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

function runScript(opts: {
  projectDir: string;
  home: string;
  allowHome?: boolean;
  scanTimeout?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: opts.projectDir,
    HOME: opts.home,
    SESSION_ID: `test-${Date.now()}-${Math.random()}`,
  };
  if (opts.allowHome) env.CLAUDE_AGENTS_MD_ALLOW_HOME = "1";
  if (opts.scanTimeout) env.CLAUDE_AGENTS_MD_SCAN_TIMEOUT = opts.scanTimeout;

  return new Promise((resolve) => {
    const proc = Bun.spawn(["bash", SCRIPT], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, exitCode]) => resolve({ stdout, stderr, exitCode }));
  });
}

describe("scan-agents-md.sh safety guards", () => {
  test("bails when PROJECT_DIR equals $HOME (no scan, no output)", async () => {
    const { home, cleanup } = await makeFakeHome();
    cleanups.push(cleanup);

    const start = Date.now();
    const { stdout, exitCode } = await runScript({ projectDir: home, home });
    const elapsed = Date.now() - start;

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stdout).not.toContain("HOME_BAIL_TEST");
    // Should be near-instant. Allow generous slack for CI cold starts.
    expect(elapsed).toBeLessThan(2000);
  });

  test("bails when PROJECT_DIR is filesystem root", async () => {
    const { home, cleanup } = await makeFakeHome();
    cleanups.push(cleanup);

    const { stdout, exitCode } = await runScript({ projectDir: "/", home });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("bails when PROJECT_DIR resolves to $HOME via symlink", async () => {
    const { home, cleanup } = await makeFakeHome();
    cleanups.push(cleanup);

    // Symlink pointing at $HOME — should still bail after realpath resolution.
    const linkParent = await mkdtemp(join(tmpdir(), "agents-md-link-"));
    cleanups.push(() => rm(linkParent, { recursive: true, force: true }));
    const link = join(linkParent, "home-link");
    await symlink(home, link);

    const { stdout, exitCode } = await runScript({ projectDir: link, home });

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("HOME_BAIL_TEST");
  });

  test("CLAUDE_AGENTS_MD_ALLOW_HOME=1 disables the $HOME bail", async () => {
    const { home, cleanup } = await makeFakeHome();
    cleanups.push(cleanup);

    const { stdout, exitCode } = await runScript({
      projectDir: home,
      home,
      allowHome: true,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("HOME_BAIL_TEST");
  });

  test("normal project under $HOME still scans (no false bail)", async () => {
    const { home, cleanup } = await makeFakeHome();
    cleanups.push(cleanup);

    const project = join(home, "myproject");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "AGENTS.md"), "PROJECT_SCAN_TEST: must be injected.");

    const { stdout, exitCode } = await runScript({ projectDir: project, home });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("PROJECT_SCAN_TEST");
  });
});
