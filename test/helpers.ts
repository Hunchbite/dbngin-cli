import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlist, readPlist } from "../src/plist";
import { freePort } from "../src/ports";
import type { Service } from "../src/registry";

export const E2E = process.env.DBNGIN_E2E === "1";
export const CLI = join(import.meta.dir, "../src/cli.ts");
export const SHARED = "/Users/Shared/DBngin";
export const UID = process.getuid!();

/** Engine versions DBngin has unpacked on this Mac, newest first. */
export function installed(dir: string): string[] {
  const root = join(SHARED, dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((v) => existsSync(join(root, v, "bin")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

let nextPort = 41000 + Math.floor(Math.random() * 15000);
/** A port nothing is listening on, never handed out twice in one run. */
export function port(): number {
  nextPort = freePort(nextPort + 1, new Set());
  return nextPort;
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

/**
 * A throwaway DBngin "home": its own service list, data folders and Trash. Engine
 * binaries come from the real /Users/Shared/DBngin unless overridden.
 */
export function sandbox(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "dbngin-test-"));
  const home = join(root, "home");
  const trash = join(root, "trash");
  mkdirSync(trash, { recursive: true });
  const env: Record<string, string> = {
    DBNGIN_HOME: home,
    DBNGIN_TRASH: trash,
    DBNGIN_IGNORE_APP: "1",
    DBNGIN_APP: join(root, "NoSuch.app"),
    NO_COLOR: "1",
    ...extraEnv,
  };

  function cli(args: string[], more: Record<string, string> = {}): Result {
    const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, ...env, ...more }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  }

  const sb = {
    root,
    home,
    trash,
    env,
    cli,
    /** Run and expect success. */
    ok(...args: string[]): Result {
      const r = cli(args);
      if (r.code !== 0) throw new Error(`dbngin ${args.join(" ")} → exit ${r.code}\n${r.err}\n${r.out}`);
      return r;
    },
    /** Run and expect failure with the given exit code. */
    fails(code: number, ...args: string[]): Result {
      const r = cli(args);
      if (r.code !== code) throw new Error(`dbngin ${args.join(" ")} → exit ${r.code}, expected ${code}\n${r.err}\n${r.out}`);
      return r;
    },
    json<T = any>(...args: string[]): T {
      return JSON.parse(sb.ok(...args, "--json").out) as T;
    },
    registryFile: join(home, "Data/DBEngines.plist"),
    services: (): Service[] => (existsSync(sb.registryFile) ? readPlist<Service[]>(sb.registryFile) : []),
    seed(list: Service[]) {
      mkdirSync(join(home, "Data"), { recursive: true });
      writePlist(sb.registryFile, list);
    },
    dataDir: (type: "postgresql" | "redis", id: string) => join(home, "Engines", type, id),
    /** Stop every service in the sandbox and delete it. */
    cleanup() {
      let list: Service[] = [];
      try {
        list = sb.services();
      } catch {
        /* a test may have corrupted it on purpose */
      }
      for (const s of Array.isArray(list) ? list : []) {
        cli(["stop", s.ID, "--timeout", "15"]);
        const label = s.Type === "Redis" ? `com.tinyapp.DBngin.redis-server-${s.ID}` : `com.tinyapp.DBngin.postgresql-${s.ID}`;
        Bun.spawnSync(["launchctl", "bootout", `gui/${UID}/${label}`]);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  return sb;
}

let counter = 0;
/** A service-list entry with sensible defaults, for seeding. */
export function entry(sb: { home: string }, over: Partial<Service> = {}): Service {
  counter++;
  const id = over.ID ?? randomUUID().toUpperCase();
  const type = over.Type ?? "PostgreSQL";
  const dir = over.DBPath ?? join(sb.home, "Engines", type === "Redis" ? "redis" : type.toLowerCase(), id);
  const version = over.Version ?? (type === "Redis" ? "7.0.0" : "17.0");
  return {
    LogPath: dir,
    DisableBinLog: true,
    Source: "",
    Binaries: join(SHARED, type === "Redis" ? "redis" : type.toLowerCase(), version),
    AutoStartup: false,
    Name: `svc-${counter}`,
    ID: id,
    ConfigPath: "Select a file...",
    Pid: dir,
    Port: "5432",
    SocketPath: "",
    Version: version,
    Status: "stopped",
    Type: type,
    DBPath: dir,
    ...over,
  };
}

export const launchdLoaded = (label: string) => Bun.spawnSync(["launchctl", "print", `gui/${UID}/${label}`]).exitCode === 0;

export async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(250);
  }
  return check();
}

/**
 * A long-running process with a chosen name, standing in for the DBngin app.
 * (Copies of system binaries like /bin/sleep are killed by macOS, so compile one.)
 */
export function fakeApp(dir: string, name: string) {
  const src = join(dir, "sleeper.ts");
  writeFileSync(src, "await Bun.sleep(600_000);");
  const bin = join(dir, name);
  const b = Bun.spawnSync(["bun", "build", "--compile", "--outfile", bin, src], { stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) throw new Error(b.stderr.toString());
  return Bun.spawn([bin]);
}
