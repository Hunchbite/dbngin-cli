import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appBundle, registryBackupPath, registryPath } from "./paths";
import { readPlist, writePlist } from "./plist";
import { CliError, normalizeName, run, sleep, waitFor } from "./util";

/** One entry in DBngin's service list, using the app's own key names. */
export interface Service {
  ID: string;
  Name: string;
  Type: string; // "PostgreSQL" | "Redis" | "MySQL" | "MariaDB" | ...
  Version: string;
  Port: string;
  Status: string; // what the app last saw; often stale, see service.status()
  AutoStartup: boolean;
  Binaries: string;
  DBPath: string;
  LogPath: string;
  Pid: string;
  Source: string;
  ConfigPath: string;
  SocketPath: string;
  DisableBinLog: boolean;
  [key: string]: unknown;
}

export function loadServices(): Service[] {
  if (!existsSync(registryPath())) return [];
  const data = readPlist<Service[]>(registryPath());
  if (!Array.isArray(data)) throw new CliError(`unexpected format in ${registryPath()}`);
  return data;
}

function saveServices(services: Service[]): void {
  mkdirSync(dirname(registryPath()), { recursive: true });
  if (existsSync(registryPath())) copyFileSync(registryPath(), registryBackupPath());
  writePlist(registryPath(), services);
}

// --- The DBngin app ------------------------------------------------------------------

export function appRunning(): boolean {
  if (process.env.DBNGIN_IGNORE_APP === "1") return false;
  return run(["pgrep", "-x", "DBngin"]).code === 0;
}

export async function quitApp(): Promise<void> {
  if (!appRunning()) return;
  run(["osascript", "-e", 'quit app "DBngin"']);
  const gone = await waitFor(() => !appRunning(), 15_000);
  if (!gone) throw new CliError("the DBngin app did not quit", "Quit it from its menu bar icon and try again.");
  await sleep(300);
}

export function openApp(background = true): void {
  if (!existsSync(appBundle())) throw new CliError(`DBngin is not installed at ${appBundle()}`);
  run(["open", ...(background ? ["-g"] : []), "-a", appBundle()]);
}

export interface WriteOptions {
  /** Quit the app before writing and reopen it afterwards. */
  restartApp?: boolean;
}

/**
 * Change the service list. The open app keeps its own copy in memory and writes it
 * back on its next change, which would silently undo ours, so the app must be closed
 * while we write. With `restartApp` we close it and reopen it in the background.
 */
export async function updateServices<T>(change: (services: Service[]) => T, opts: WriteOptions = {}): Promise<T> {
  const wasRunning = appRunning();
  if (wasRunning && !opts.restartApp) {
    throw new CliError(
      "the DBngin app is open, and it would overwrite this change with its own copy of the service list",
      "Quit the app first (dbngin app quit), or add --restart-app to close and reopen it for you.",
    );
  }
  if (wasRunning) await quitApp();
  try {
    const services = loadServices();
    const result = change(services);
    saveServices(services);
    return result;
  } finally {
    if (wasRunning) openApp();
  }
}

// --- Finding a service -----------------------------------------------------------------

/**
 * Find one service by ID (or an ID prefix of 4+ characters), by name (case and
 * punctuation ignored, so "my-app" finds "My App"), or by port.
 */
export function findService(services: Service[], query: string): Service {
  const q = query.trim();
  const qn = normalizeName(q);
  const tries: Array<(s: Service) => boolean> = [
    (s) => s.ID.toLowerCase() === q.toLowerCase(),
    (s) => s.Name === q,
    (s) => normalizeName(s.Name) === qn && qn !== "",
    (s) => q.length >= 4 && /^[0-9a-f-]+$/i.test(q) && s.ID.toLowerCase().startsWith(q.toLowerCase()),
    (s) => /^:?\d+$/.test(q) && s.Port === q.replace(/^:/, ""),
  ];
  for (const t of tries) {
    const hits = services.filter(t);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      const list = hits.map((s) => `  ${s.ID.slice(0, 8)}  ${s.Name}  (${s.Type} ${s.Version}, port ${s.Port})`).join("\n");
      throw new CliError(`"${query}" matches ${hits.length} services:\n${list}`, "Use the ID prefix instead.");
    }
  }
  throw new CliError(`no service matches "${query}"`, "Run `dbngin ls` to see your services.");
}
