import { run, must } from "./util";

// DBngin runs PostgreSQL and Redis as per-user launchd agents. It loads each
// service's plist straight from the service's data folder; nothing is copied into
// ~/Library/LaunchAgents. Loading the plist starts the server, unloading stops it.

const domain = () => `gui/${process.getuid!()}`;

export interface JobInfo {
  loaded: boolean;
  pid: number | null;
}

export function job(label: string): JobInfo {
  const r = run(["launchctl", "print", `${domain()}/${label}`]);
  if (r.code !== 0) return { loaded: false, pid: null };
  const m = r.stdout.match(/^\s*pid = (\d+)/m);
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

export function load(plistPath: string): void {
  must(["launchctl", "bootstrap", domain(), plistPath]);
}

/** Unload a job. launchd sends SIGTERM to a process that is still running. */
export function unload(label: string): void {
  if (!job(label).loaded) return;
  run(["launchctl", "bootout", `${domain()}/${label}`]);
}
