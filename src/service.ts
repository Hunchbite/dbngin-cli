import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { binariesDir, install, installedVersions } from "./binaries";
import { type Engine, ENGINES, engineFor, isDir, plistPath } from "./engines";
import * as launchd from "./launchd";
import { enginesDir, trashDir } from "./paths";
import { freePort, portOwner } from "./ports";
import { type Service, type WriteOptions, findService, loadServices, updateServices } from "./registry";
import { CliError, normalizeName, pidAlive, waitFor } from "./util";

export type State = "running" | "stopped" | "failing" | "missing" | "unsupported";

export interface ServiceStatus {
  state: State;
  pid: number | null;
  /** Whether launchd is managing the process (false = started some other way, e.g. pg_ctl). */
  managed: boolean;
}

/**
 * The real state of a service, read from its pid file and launchd. The `Status` the
 * app writes into the service list is only what it last saw and is often wrong.
 */
export function status(s: Service): ServiceStatus {
  const e = ENGINES.find((e) => e.type === s.Type);
  if (!e) return { state: "unsupported", pid: null, managed: false };
  if (!isDir(s.DBPath)) return { state: "missing", pid: null, managed: false };
  const pid = e.runningPid(s);
  const job = launchd.job(e.label(s));
  if (pid) return { state: "running", pid, managed: job.loaded };
  // Loaded but no server: launchd is restarting a server that keeps exiting.
  if (job.loaded) return { state: "failing", pid: null, managed: true };
  return { state: "stopped", pid: null, managed: false };
}

/** Which service, if any, owns a process. */
function serviceWithPid(pid: number): Service | undefined {
  return loadServices().find((s) => ENGINES.some((e) => e.type === s.Type) && isDir(s.DBPath) && engineFor(s).runningPid(s) === pid);
}

function tail(file: string, lines: number): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

export interface StartResult {
  already: boolean;
  status: ServiceStatus;
}

export async function start(s: Service, timeoutMs = 30_000): Promise<StartResult> {
  const e = engineFor(s);
  const st = status(s);
  if (st.state === "missing") throw new CliError(`the data folder for "${s.Name}" is missing: ${s.DBPath}`);
  if (st.state === "running") return { already: true, status: st };
  if (!isDir(join(s.Binaries, "bin"))) {
    throw new CliError(`${s.Type} ${s.Version} is not installed (${s.Binaries})`, `Run \`dbngin install ${e.dir} ${s.Version}\`.`);
  }

  const owner = portOwner(Number(s.Port));
  if (owner) {
    const other = owner.pid ? serviceWithPid(owner.pid) : undefined;
    const who = other ? `the DBngin service "${other.Name}"` : `${owner.command}${owner.pid ? ` (pid ${owner.pid})` : ""}`;
    throw new CliError(
      `port ${s.Port} is already in use by ${who}`,
      other
        ? `Stop "${other.Name}" first, or give this service its own port: \`dbngin set ${quote(s.Name)} --port <port>\`.`
        : `Give this service its own port: \`dbngin set ${quote(s.Name)} --port <port>\` (or free the port, if that program isn't needed).`,
    );
  }

  // Rewrite the plist from the service list so port and version changes take effect.
  writeFileSync(plistPath(e, s), e.plist(s));
  launchd.unload(e.label(s)); // clears a "failing" job
  launchd.load(plistPath(e, s));

  const ok = await waitFor(() => e.runningPid(s) !== null && e.ready(s), timeoutMs);
  if (!ok) {
    launchd.unload(e.label(s)); // don't leave launchd restarting it forever
    const log = e.logFiles(s).map((f) => tail(f, 15)).filter(Boolean).join("\n");
    throw new CliError(`"${s.Name}" did not start within ${timeoutMs / 1000}s`, log ? `Last log lines:\n${log}` : undefined);
  }
  return { already: false, status: status(s) };
}

export async function stop(s: Service, timeoutMs = 30_000): Promise<{ already: boolean }> {
  const e = engineFor(s);
  const st = status(s);
  if (st.state !== "running" && st.state !== "failing") return { already: true };

  // Signal first so the server shuts down cleanly, then unload so launchd's
  // KeepAlive doesn't start it again. This also stops servers launchd doesn't manage.
  if (st.pid) {
    try {
      process.kill(st.pid, e.stopSignal);
    } catch {
      /* already exiting */
    }
  }
  launchd.unload(e.label(s));

  if (st.pid) {
    const gone = await waitFor(() => !pidAlive(st.pid!), timeoutMs);
    if (!gone) throw new CliError(`"${s.Name}" (pid ${st.pid}) is still shutting down after ${timeoutMs / 1000}s`, "Check `dbngin logs` for what it is waiting on.");
  }
  return { already: false };
}

export interface CreateOptions extends WriteOptions {
  engine: Engine;
  name: string;
  version?: string;
  port?: number;
  autostart?: boolean;
  log?: (msg: string) => void;
}

export async function create(opts: CreateOptions): Promise<Service> {
  const e = opts.engine;
  const log = opts.log ?? (() => {});
  const name = opts.name.trim();
  if (!name) throw new CliError("the service needs a name");

  const version = opts.version ?? installedVersions(e)[0];
  if (!version) throw new CliError(`no ${e.type} version is installed`, `Pick one with \`dbngin versions ${e.dir} --available\` and pass --version.`);
  const binaries = await install(e, version, log);

  return updateServices((services) => {
    if (services.some((s) => normalizeName(s.Name) === normalizeName(name))) {
      throw new CliError(`a service named "${name}" already exists`, "Pick another name.");
    }
    const claimed = new Set(services.map((s) => Number(s.Port)));
    const port = opts.port ?? freePort(e.defaultPort, claimed);
    const clash = services.find((s) => Number(s.Port) === port);
    if (clash) log(`Note: port ${port} is also set on "${clash.Name}"; only one of them can run at a time.`);

    const id = randomUUID().toUpperCase();
    const dir = join(enginesDir(), e.dir, id);
    const s: Service = {
      LogPath: dir,
      DisableBinLog: true,
      Source: `https://files.dbngin.com/binaries/${e.dir}/${version}.zip`,
      Binaries: binaries,
      AutoStartup: opts.autostart ?? false,
      Name: name,
      ID: id,
      ConfigPath: "Select a file...",
      Pid: dir,
      Port: String(port),
      SocketPath: "",
      Version: version,
      Status: "stopped",
      Type: e.type,
      DBPath: dir,
    };
    log(`Creating ${e.type} ${version} data folder …`);
    try {
      e.init(s);
      writeFileSync(plistPath(e, s), e.plist(s));
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    services.push(s);
    return s;
  }, opts);
}

export interface UpdateOptions extends WriteOptions {
  name?: string;
  port?: number;
  autostart?: boolean;
}

/** Rename, move to another port, or toggle start-with-the-app. Returns the updated service. */
export async function update(s: Service, opts: UpdateOptions): Promise<Service> {
  const e = engineFor(s);
  return updateServices((services) => {
    const target = services.find((x) => x.ID === s.ID);
    if (!target) throw new CliError(`"${s.Name}" disappeared from the service list`);
    if (opts.name !== undefined) {
      const dup = services.find((x) => x.ID !== s.ID && normalizeName(x.Name) === normalizeName(opts.name!));
      if (dup) throw new CliError(`a service named "${dup.Name}" already exists`);
      target.Name = opts.name.trim();
    }
    if (opts.port !== undefined) target.Port = String(opts.port);
    if (opts.autostart !== undefined) target.AutoStartup = opts.autostart;
    if (isDir(target.DBPath)) writeFileSync(plistPath(e, target), e.plist(target));
    return target;
  }, opts);
}

export interface RemoveOptions extends WriteOptions {
  /** Delete the data permanently instead of moving it to the Trash. */
  purge?: boolean;
}

/** Stop a service, drop it from the list, and move its data to the Trash (or delete it). */
export async function remove(s: Service, opts: RemoveOptions = {}): Promise<{ trashedTo?: string }> {
  const e = ENGINES.find((x) => x.type === s.Type);
  if (e) {
    await stop(s);
    launchd.unload(e.label(s));
  }

  // Only ever touch folders inside DBngin's own Engines folder.
  const dir = resolve(s.DBPath);
  const safe = dir.startsWith(resolve(enginesDir()) + sep) && dir.includes(s.ID);

  await updateServices((services) => {
    const i = services.findIndex((x) => x.ID === s.ID);
    if (i >= 0) services.splice(i, 1);
  }, opts);

  if (!isDir(dir)) return {};
  if (!safe) throw new CliError(`removed "${s.Name}" from the list but left its data alone: ${dir} is outside ${enginesDir()}`);
  if (opts.purge) {
    rmSync(dir, { recursive: true, force: true });
    return {};
  }
  const trashed = join(trashDir(), `DBngin ${s.Name.replace(/[/:]/g, "-")} ${s.ID.slice(0, 8)} ${Date.now()}`);
  renameSync(dir, trashed);
  return { trashedTo: trashed };
}

export function resolveService(query: string): Service {
  return findService(loadServices(), query);
}

export const quote = (name: string) => (/^[\w.-]+$/.test(name) ? name : `"${name}"`);

export { binariesDir };
