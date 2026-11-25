// End-to-end: drives real PostgreSQL and Redis servers through launchd, using the
// engine binaries DBngin already installed but a throwaway service list and data
// folder. Your real DBngin services are never touched.
//
//   DBNGIN_E2E=1 bun test test/e2e.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.DBNGIN_E2E === "1";
const home = mkdtempSync(join(tmpdir(), "dbngin-e2e-"));
const env = { ...process.env, DBNGIN_HOME: home, DBNGIN_IGNORE_APP: "1", NO_COLOR: "1" };
const cli = join(import.meta.dir, "../src/cli.ts");

function dbngin(...args: string[]) {
  const p = Bun.spawnSync(["bun", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
function ok(...args: string[]) {
  const r = dbngin(...args);
  if (r.code !== 0) throw new Error(`dbngin ${args.join(" ")} failed (${r.code}):\n${r.err}\n${r.out}`);
  return r;
}

const installed = (dir: string) => {
  const root = `/Users/Shared/DBngin/${dir}`;
  return existsSync(root) ? readdirSync(root).filter((v) => existsSync(join(root, v, "bin"))) : [];
};
const port = 40000 + Math.floor(Math.random() * 20000);

afterAll(() => {
  // Best effort: stop anything a failed test left running, then delete the sandbox.
  for (const name of ["e2e-pg", "e2e-moved", "e2e-redis"]) dbngin("stop", name);
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!enabled || installed("postgresql").length === 0)("postgres lifecycle", () => {
  test("create → databases → stop/start → move port → remove", () => {
    const url = ok("create", "e2e-pg", "--port", String(port), "--db", "shop").out;
    expect(url).toBe(`postgresql://postgres@127.0.0.1:${port}/shop`);

    const ls = JSON.parse(ok("ls", "--json").out);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ name: "e2e-pg", port, state: "running", managedByLaunchd: true });

    expect(ok("start", "e2e-pg").err).toContain("already running");
    expect(ok("shell", "e2e-pg", "shop", "--", "-Atc", "select 40 + 2").out).toBe("42");

    ok("db", "create", "e2e-pg", "blog");
    const dbs = JSON.parse(ok("db", "ls", "e2e-pg", "--json").out).map((d: { name: string }) => d.name);
    expect(dbs).toEqual(["blog", "postgres", "shop"]);

    const dump = join(home, "shop.dump");
    ok("db", "dump", "e2e-pg", "shop", "-o", dump);
    ok("db", "restore", "e2e-pg", "shop_copy", dump, "--create");
    ok("db", "drop", "e2e-pg", "blog", "--yes");
    expect(dbngin("db", "drop", "e2e-pg", "shop").code).not.toBe(0); // needs --yes without a terminal

    ok("stop", "e2e-pg");
    expect(JSON.parse(ok("info", "e2e-pg", "--json").out).state).toBe("stopped");
    expect(ok("stop", "e2e-pg").err).toContain("already stopped");

    ok("set", "e2e-pg", "--port", String(port + 1), "--name", "e2e-moved");
    ok("start", "e2e-moved");
    expect(ok("url", "e2e-moved").out).toBe(`postgresql://postgres@127.0.0.1:${port + 1}/postgres`);
    expect(ok("doctor").code).toBe(0);

    const dataDir = JSON.parse(ok("info", "e2e-moved", "--json").out).dataDir;
    ok("rm", "e2e-moved", "--purge", "--yes");
    expect(existsSync(dataDir)).toBe(false);
    expect(JSON.parse(ok("ls", "--json").out)).toHaveLength(0);
  }, 120_000);

  test("sees and stops a server started outside launchd (pg_ctl)", () => {
    ok("create", "e2e-manual", "--port", String(port + 4));
    const info = JSON.parse(ok("info", "e2e-manual", "--json").out);
    const pgctl = join(info.binaries, "bin/pg_ctl");
    const started = Bun.spawnSync([pgctl, "-D", info.dataDir, "-o", `-p ${port + 4}`, "-l", join(home, "manual.log"), "-w", "start"]);
    expect(started.exitCode).toBe(0);
    try {
      const st = JSON.parse(ok("info", "e2e-manual", "--json").out);
      expect(st).toMatchObject({ state: "running", managedByLaunchd: false });
      ok("stop", "e2e-manual");
      expect(JSON.parse(ok("info", "e2e-manual", "--json").out).state).toBe("stopped");
    } finally {
      Bun.spawnSync([pgctl, "-D", info.dataDir, "-m", "immediate", "stop"]);
      dbngin("rm", "e2e-manual", "--purge", "--yes");
    }
  }, 60_000);

  test("start refuses a port that is already taken", () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: port + 2, socket: { data() {} } });
    try {
      ok("create", "e2e-busy", "--port", String(port + 2));
      const r = dbngin("start", "e2e-busy");
      expect(r.code).toBe(1);
      expect(r.err).toContain(`port ${port + 2} is already in use`);
    } finally {
      server.stop(true);
      dbngin("rm", "e2e-busy", "--purge", "--yes");
    }
  }, 60_000);
});

describe.skipIf(!enabled || installed("redis").length === 0)("redis lifecycle", () => {
  test("create → start → ping → stop → remove", () => {
    ok("create", "e2e-redis", "--engine", "redis", "--port", String(port + 3), "--start");
    expect(ok("shell", "e2e-redis", "--", "ping").out).toBe("PONG");
    expect(ok("env", "e2e-redis", "--json").out).toContain(`redis://127.0.0.1:${port + 3}/0`);
    ok("stop", "e2e-redis");
    expect(JSON.parse(ok("info", "e2e-redis", "--json").out).state).toBe("stopped");
    ok("rm", "e2e-redis", "--purge", "--yes");
  }, 60_000);
});
