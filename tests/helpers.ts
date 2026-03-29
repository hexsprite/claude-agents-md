/**
 * Test helpers for driving the Claude CLI via Bun's Terminal (PTY) API.
 */
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const PLUGIN_DIR = join(import.meta.dir, "..");
const CLAUDE_BIN = "claude";

/** Strip ANSI escape codes from terminal output */
function stripAnsi(str: string): string {
  return str.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
}

interface ClaudeSessionOptions {
  /** Working directory for the Claude session */
  cwd: string;
  /** Timeout in ms before killing the process (default: 60s) */
  timeout?: number;
  /** Extra CLI args */
  args?: string[];
}

interface ClaudeSession {
  /** All output received from the terminal (ANSI stripped) */
  output: string;
  /** Raw output including ANSI codes */
  rawOutput: string;
  /** Wait for a pattern to appear in output (ANSI stripped) */
  waitFor: (pattern: string | RegExp, timeoutMs?: number) => Promise<string>;
  /** Send raw bytes to the terminal */
  write: (input: string) => void;
  /** Send text + Enter (carriage return) to submit a prompt */
  send: (input: string) => void;
  /** Kill the session */
  kill: () => void;
  /** Wait for process to exit */
  exited: Promise<number>;
  /** The underlying process */
  proc: ReturnType<typeof Bun.spawn>;
}

/**
 * Spawn a Claude CLI session in a PTY with our plugin loaded.
 */
export function spawnClaude(opts: ClaudeSessionOptions): ClaudeSession {
  const { cwd, timeout = 60_000, args = [] } = opts;

  let output = "";
  const waiters: Array<{
    pattern: string | RegExp;
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
  }> = [];

  const proc = Bun.spawn(
    [CLAUDE_BIN, "--plugin-dir", PLUGIN_DIR, ...args],
    {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: 120,
        rows: 30,
        data(_terminal, data) {
          const text = new TextDecoder().decode(data);
          output += text;

          // Check pending waiters against clean (ANSI-stripped) output
          const clean = stripAnsi(output);
          for (let i = waiters.length - 1; i >= 0; i--) {
            const waiter = waiters[i];
            const matched =
              typeof waiter.pattern === "string"
                ? clean.includes(waiter.pattern)
                : waiter.pattern.test(clean);
            if (matched) {
              waiters.splice(i, 1);
              waiter.resolve(clean);
            }
          }
        },
      },
    }
  );

  // Auto-kill after timeout
  const killTimer = setTimeout(() => {
    proc.kill();
  }, timeout);

  proc.exited.then(() => clearTimeout(killTimer));

  function waitFor(
    pattern: string | RegExp,
    timeoutMs = 30_000
  ): Promise<string> {
    // Check if already matched (against clean output)
    const clean = stripAnsi(output);
    const alreadyMatched =
      typeof pattern === "string"
        ? clean.includes(pattern)
        : pattern.test(clean);
    if (alreadyMatched) return Promise.resolve(clean);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(
          new Error(
            `Timeout waiting for pattern: ${pattern}\n\nOutput so far:\n${stripAnsi(output)}`
          )
        );
      }, timeoutMs);

      waiters.push({
        pattern,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject,
      });
    });
  }

  return {
    get output() {
      return stripAnsi(output);
    },
    /** Raw output including ANSI codes */
    get rawOutput() {
      return output;
    },
    waitFor,
    /** Send text + Enter (carriage return) to the PTY */
    write: (input: string) => proc.terminal!.write(input),
    /** Send text + Enter to submit a prompt */
    send: (input: string) => proc.terminal!.write(input + "\r"),
    kill: () => {
      clearTimeout(killTimer);
      proc.kill();
    },
    exited: proc.exited,
    proc,
  };
}

/**
 * Create a temporary project directory with optional files.
 */
export async function createTempProject(
  files: Record<string, string> = {}
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "claude-agents-md-test-"));

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    const parentDir = join(fullPath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
