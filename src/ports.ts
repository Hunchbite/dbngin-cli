import { run } from "./util";

export interface PortOwner {
  pid: number;
  command: string;
}

/** Who is listening on a TCP port, if anyone. */
export function portOwner(port: number): PortOwner | null {
  const r = run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (r.code === 0) {
    const pid = r.stdout.match(/^p(\d+)/m);
    const cmd = r.stdout.match(/^c(.+)$/m);
    if (pid) return { pid: Number(pid[1]), command: cmd?.[1] ?? "?" };
  }
  // lsof can't see sockets owned by other users (for example a system-wide MySQL),
  // so fall back to trying to bind the port ourselves.
  return canBind(port) ? null : { pid: 0, command: "another user's process" };
}

function canBind(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** First port at or above `start` that no service claims and nothing is listening on. */
export function freePort(start: number, claimed: Set<number>): number {
  for (let p = start; p < 65535; p++) {
    if (!claimed.has(p) && !portOwner(p)) return p;
  }
  throw new Error("no free port found");
}
