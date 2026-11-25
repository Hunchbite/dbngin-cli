import { basename } from "node:path";

/** An error meant for the user: printed without a stack trace, optionally with a hint. */
export class CliError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public exitCode = 1,
  ) {
    super(message);
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
}

/** Run a command synchronously and capture its output. Never throws for a non-zero exit. */
export function run(cmd: string[], opts: RunOptions = {}): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: opts.input !== undefined ? Buffer.from(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `${cmd[0]}: ${(e as Error).message}` };
  }
}

/** Run a command and return stdout, throwing a CliError when it fails. */
export function must(cmd: string[], opts: RunOptions = {}): string {
  const r = run(cmd, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim();
    throw new CliError(`${basename(cmd[0]!)} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`);
  }
  return r.stdout;
}

/** Run a command attached to the user's terminal. Returns its exit code. */
export function interactive(cmd: string[], opts: RunOptions = {}): number {
  try {
    const p = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return p.exitCode ?? 1;
  } catch (e) {
    throw new CliError(`could not run ${cmd[0]}: ${(e as Error).message}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it returns truthy or the timeout passes. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs: number, intervalMs = 250): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processCommand(pid: number): string | null {
  const r = run(["ps", "-p", String(pid), "-o", "command="]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Compare version strings like "17.0", "18.4_arm", "9.5.0_arm64" by their numeric parts. */
export function compareVersions(a: string, b: string): number {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

/** Lowercase and strip everything but letters and digits, so "My App" matches "my-app". */
export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
