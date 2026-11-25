// End-to-end: real PostgreSQL and Redis servers driven through launchd, using the
// engine binaries DBngin installed but a throwaway service list and data folder.
// Your real DBngin services are never touched.
//
//   DBNGIN_E2E=1 bun test
//
// Download tests also need the network and fetch an ~8 MB Redis build.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E, SHARED, UID, installed, launchdLoaded, port, sandbox, until } from "./helpers";

const PG = installed("postgresql")[0];
const REDIS = installed("redis")[0];
const pgLabel = (id: string) => `com.tinyapp.DBngin.postgresql-${id}`;

const sb = sandbox();
afterAll(() => sb.cleanup());

type Info = { name: string; id: string; port: number; state: string; pid: number | null; managedByLaunchd: boolean; dataDir: string; binaries: string; autostart: boolean };
const info = (svc: string) => sb.json<Info>("info", svc);
const psqlBin = () => join(SHARED, "postgresql", PG!, "bin/psql");

/** A psql session that holds a connection open for a while. */
function holdConnection(p: number, db: string) {
  return Bun.spawn([psqlBin(), "-h", "127.0.0.1", "-p", String(p), "-U", "postgres", "-d", db, "-Atc", "select pg_sleep(60)"], { stdout: "ignore", stderr: "ignore" });
}

describe.skipIf(!E2E || !PG)("PostgreSQL", () => {
  test("full lifecycle: create → databases → stop/start → move → remove", () => {
    const p = port();
    expect(sb.ok("create", "E2E Shop", "--port", String(p), "--db", "shop").out).toBe(`postgresql://postgres@127.0.0.1:${p}/shop`);
    expect(info("e2e-shop")).toMatchObject({ name: "E2E Shop", port: p, state: "running", managedByLaunchd: true });
    expect(sb.ok("start", "e2e-shop").err).toContain("already running");
    expect(sb.ok("shell", "e2e-shop", "shop", "--", "-Atc", "select 40 + 2").out).toBe("42");

    sb.ok("db", "create", "e2e-shop", "blog");
    expect(sb.json<{ name: string }[]>("db", "ls", "e2e-shop").map((d) => d.name)).toEqual(["blog", "postgres", "shop"]);

    sb.ok("shell", "e2e-shop", "shop", "--", "-c", "create table t(x int); insert into t values (1),(2),(3)");
    const dump = join(sb.root, "shop.dump");
    sb.ok("db", "dump", "e2e-shop", "shop", "-o", dump);
    sb.ok("db", "restore", "e2e-shop", "shop_copy", dump, "--create");
    expect(sb.ok("shell", "e2e-shop", "shop_copy", "--", "-Atc", "select sum(x) from t").out).toBe("6");
    expect(sb.fails(1, "db", "restore", "e2e-shop", "x", join(sb.root, "nope.dump")).err).toContain("file not found");

    sb.ok("db", "drop", "e2e-shop", "blog", "--yes");
    expect(sb.fails(1, "db", "drop", "e2e-shop", "shop").err).toContain("without confirmation");

    sb.ok("stop", "e2e-shop");
    expect(info("e2e-shop").state).toBe("stopped");
    expect(launchdLoaded(pgLabel(info("e2e-shop").id))).toBe(false);
    expect(sb.ok("stop", "e2e-shop").err).toContain("already stopped");

    sb.ok("set", "e2e-shop", "--port", String(p + 1), "--name", "e2e-moved", "--autostart", "on");
    sb.ok("start", "e2e-moved");
    expect(info("e2e-moved")).toMatchObject({ port: p + 1, state: "running", autostart: true });
    expect(sb.ok("shell", "e2e-moved", "shop", "--", "-Atc", "select count(*) from t").out).toBe("3"); // data survived

    const dir = info("e2e-moved").dataDir;
    sb.ok("rm", "e2e-moved", "--purge", "--yes");
    expect(existsSync(dir)).toBe(false);
    expect(sb.json("ls")).toEqual([]);
  }, 120_000);

  test("defaults: newest installed version and the first free port from 5432", () => {
    const s = sb.json<Info>("create", "e2e-defaults");
    try {
      expect(s.binaries).toBe(join(SHARED, "postgresql", PG!));
      expect(s.port).toBeGreaterThanOrEqual(5432);
      // Port picked must not be one anything is listening on.
      expect(Bun.spawnSync(["lsof", "-nP", `-iTCP:${s.port}`, "-sTCP:LISTEN"]).exitCode).not.toBe(0);
      expect(sb.fails(1, "create", "E2E-DEFAULTS").err).toContain("already exists");
    } finally {
      sb.ok("rm", "e2e-defaults", "--purge", "--yes");
    }
  }, 60_000);

  test("restart gives a new process; a new port takes effect on restart", () => {
    const p = port();
    sb.ok("create", "e2e-restart", "--port", String(p), "--start");
    try {
      const before = info("e2e-restart").pid;
      sb.ok("restart", "e2e-restart");
      const after = info("e2e-restart");
      expect(after.state).toBe("running");
      expect(after.pid).not.toBe(before);

      const q = port();
      expect(sb.ok("set", "e2e-restart", "--port", String(q)).err).toContain(`still running on port ${p}`);
      sb.ok("restart", "e2e-restart");
      expect(Bun.spawnSync([join(SHARED, "postgresql", PG!, "bin/pg_isready"), "-h", "127.0.0.1", "-p", String(q)]).exitCode).toBe(0);
    } finally {
      sb.ok("rm", "e2e-restart", "--purge", "--yes");
    }
  }, 60_000);

  test("two services on one port: the second is refused and told which service holds it", () => {
    const p = port();
    sb.ok("create", "e2e-first", "--port", String(p), "--start");
    sb.ok("create", "e2e-second", "--port", String(p));
    try {
      const r = sb.fails(1, "start", "e2e-second");
      expect(r.err).toContain(`port ${p} is already in use by the DBngin service "e2e-first"`);
      expect(r.err).toContain("dbngin set e2e-second --port");
      expect(sb.ok("doctor").out).toContain(`2 services share port ${p}`);
    } finally {
      sb.ok("rm", "e2e-first", "--purge", "--yes");
      sb.ok("rm", "e2e-second", "--purge", "--yes");
    }
  }, 60_000);

  test("stop does not wait for open client connections", async () => {
    const p = port();
    sb.ok("create", "e2e-busyclients", "--port", String(p), "--start");
    const client = holdConnection(p, "postgres");
    try {
      await Bun.sleep(500);
      const t = Date.now();
      sb.ok("stop", "e2e-busyclients", "--timeout", "15");
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(await client.exited).not.toBe(0); // the session was disconnected
    } finally {
      client.kill();
      sb.ok("rm", "e2e-busyclients", "--purge", "--yes");
    }
  }, 60_000);

  test("dropping a database in use needs --force; bad owner fails cleanly", async () => {
    const p = port();
    sb.ok("create", "e2e-drop", "--port", String(p), "--db", "busy");
    const client = holdConnection(p, "busy");
    try {
      await Bun.sleep(500);
      expect(sb.fails(1, "db", "drop", "e2e-drop", "busy", "--yes").err).toContain("being accessed by other users");
      sb.ok("db", "drop", "e2e-drop", "busy", "--yes", "--force");
      expect(sb.json<{ name: string }[]>("db", "ls", "e2e-drop").map((d) => d.name)).not.toContain("busy");
      expect(sb.fails(1, "db", "create", "e2e-drop", "x", "--owner", "nobody_here").err).toContain("createdb failed");
      expect(sb.fails(2, "db", "explode", "e2e-drop").err).toContain('unknown db action "explode"');
    } finally {
      client.kill();
      sb.ok("rm", "e2e-drop", "--purge", "--yes");
    }
  }, 60_000);

  test("logs show the server log", () => {
    sb.ok("create", "e2e-logs", "--port", String(port()), "--start");
    try {
      const out = sb.ok("logs", "e2e-logs", "-n", "50").out;
      expect(out).toContain("database system is ready to accept connections");
      expect(out).not.toContain("does not exist"); // readiness checks connect as postgres, not the macOS user
    } finally {
      sb.ok("rm", "e2e-logs", "--purge", "--yes");
    }
  }, 60_000);

  test("a server that won't start: start times out, shows the log and cleans up; failing jobs are detected", async () => {
    const s = sb.json<Info>("create", "e2e-broken", "--port", String(port()));
    try {
      rmSync(join(s.dataDir, "PG_VERSION")); // corrupt the data folder
      const r = sb.fails(1, "start", "e2e-broken", "--timeout", "4");
      expect(r.err).toContain("did not start within 4s");
      expect(r.err).toContain("Last log lines");
      expect(launchdLoaded(pgLabel(s.id))).toBe(false); // not left crash-looping

      // Loaded behind our back (e.g. by the app): reported as failing, and stop clears it.
      Bun.spawnSync(["launchctl", "bootstrap", `gui/${UID}`, join(s.dataDir, `${pgLabel(s.id)}.plist`)]);
      expect(await until(() => info("e2e-broken").state === "failing", 5_000)).toBe(true);
      const d = sb.cli(["doctor"]);
      expect(d.code).toBe(1);
      expect(d.out).toContain("keeps restarting");
      sb.ok("stop", "e2e-broken");
      expect(info("e2e-broken").state).toBe("stopped");
      expect(launchdLoaded(pgLabel(s.id))).toBe(false);
    } finally {
      sb.ok("rm", "e2e-broken", "--purge", "--yes");
    }
  }, 60_000);

  test("launchd brings a crashed server back", async () => {
    const p = port();
    sb.ok("create", "e2e-crash", "--port", String(p), "--start");
    try {
      const pid = info("e2e-crash").pid!;
      process.kill(pid, "SIGKILL");
      const back = await until(() => {
        const s = info("e2e-crash");
        return s.state === "running" && s.pid !== pid;
      }, 40_000);
      expect(back).toBe(true);
    } finally {
      sb.ok("rm", "e2e-crash", "--purge", "--yes");
    }
  }, 60_000);

  test("sees and stops a server started outside launchd (pg_ctl)", () => {
    const p = port();
    const s = sb.json<Info>("create", "e2e-manual", "--port", String(p));
    const pgctl = join(s.binaries, "bin/pg_ctl");
    expect(Bun.spawnSync([pgctl, "-D", s.dataDir, "-o", `-p ${p}`, "-l", join(sb.root, "manual.log"), "-w", "start"]).exitCode).toBe(0);
    try {
      expect(info("e2e-manual")).toMatchObject({ state: "running", managedByLaunchd: false });
      expect(sb.ok("doctor").out).toContain("running outside launchd");
      sb.ok("stop", "e2e-manual");
      expect(info("e2e-manual").state).toBe("stopped");
    } finally {
      Bun.spawnSync([pgctl, "-D", s.dataDir, "-m", "immediate", "stop"]);
      sb.ok("rm", "e2e-manual", "--purge", "--yes");
    }
  }, 60_000);

  test("start refuses a port something else is using, and names it", () => {
    const p = port();
    const server = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } });
    try {
      sb.ok("create", "e2e-taken", "--port", String(p));
      const r = sb.fails(1, "start", "e2e-taken");
      expect(r.err).toContain(`port ${p} is already in use by bun (pid ${process.pid})`);
    } finally {
      server.stop(true);
      sb.ok("rm", "e2e-taken", "--purge", "--yes");
    }
  }, 60_000);

  test("rm of a running service stops it and moves the data to the Trash", () => {
    const s = sb.json<Info>("create", "e2e-trash", "--port", String(port()), "--start");
    sb.ok("rm", "e2e-trash", "--yes");
    expect(existsSync(s.dataDir)).toBe(false);
    expect(launchdLoaded(pgLabel(s.id))).toBe(false);
    const trashed = readdirSync(sb.trash).find((f) => f.includes(s.id.slice(0, 8)));
    expect(trashed).toBeDefined();
    expect(existsSync(join(sb.trash, trashed!, "PG_VERSION"))).toBe(true); // data intact
  }, 60_000);
});

describe.skipIf(!E2E || !REDIS)("Redis", () => {
  test("create → start → use → restart → stop → remove", () => {
    const p = port();
    sb.ok("create", "e2e-redis", "--engine", "redis", "--port", String(p), "--start");
    try {
      expect(sb.ok("shell", "e2e-redis", "--", "ping").out).toBe("PONG");
      sb.ok("shell", "e2e-redis", "3", "--", "set", "k", "v");
      expect(sb.ok("url", "e2e-redis", "3").out).toBe(`redis://127.0.0.1:${p}/3`);
      expect(sb.json("env", "e2e-redis")).toMatchObject({ REDIS_URL: `redis://127.0.0.1:${p}/0`, REDIS_PORT: String(p) });
      expect(sb.fails(2, "create", "x", "--engine", "redis", "--db", "a").err).toContain("--db only works with PostgreSQL");

      const before = info("e2e-redis").pid;
      sb.ok("restart", "e2e-redis");
      expect(info("e2e-redis").pid).not.toBe(before);
      sb.ok("stop", "e2e-redis");
      expect(info("e2e-redis").state).toBe("stopped");
      expect(sb.ok("logs", "e2e-redis", "-n", "20").out).toContain("Ready to accept connections");
    } finally {
      sb.ok("rm", "e2e-redis", "--purge", "--yes");
    }
  }, 60_000);
});

describe.skipIf(!E2E)("engine versions and downloads (network)", () => {
  const binaries = join(sb.root, "binaries");
  mkdirSync(binaries, { recursive: true });
  const withBinaries = { DBNGIN_BINARIES: binaries };

  test("catalog lists versions for this Mac", () => {
    const v = sb.json<Record<string, { installed: string[]; available: string[] }>>("versions", "--available");
    expect(v.postgresql!.available.length).toBeGreaterThan(0);
    expect(v.redis!.available.length).toBeGreaterThan(0);
    expect(sb.fails(1, "install", "redis", "0.0.1").err).toContain("not in DBngin's catalog");
  }, 30_000);

  // DBngin's builds have /Users/Shared/DBngin baked in and only run from there, so
  // this installs into the real folder (as the app would) and removes only what it added.
  test("create with a version that isn't installed downloads it first", () => {
    const v = sb.json<Record<string, { installed: string[]; available: string[] }>>("versions", "redis", "--available").redis!;
    const version = v.available.find((x) => !v.installed.includes(x));
    if (!version) return; // every catalog version is already installed; nothing to download
    const dir = join(SHARED, "redis", version);
    const r = sb.cli(["create", "e2e-dl", "--engine", "redis", "--version", version, "--port", String(port()), "--start"]);
    try {
      expect(r.code).toBe(0);
      expect(r.err).toContain(`Downloading https://files.dbngin.com/binaries/redis/${version}.zip`);
      expect(sb.ok("shell", "e2e-dl", "--", "ping").out).toBe("PONG");
      expect(sb.ok("install", "redis", version).err).not.toContain("Downloading"); // already there
    } finally {
      sb.cli(["rm", "e2e-dl", "--purge", "--yes"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  const bundled = readdirSync("/Applications/DBngin.app/Contents/Resources").find((f) => /^postgresql_.*\.zip$/.test(f));
  test.skipIf(!bundled)("install unpacks the archive bundled inside DBngin.app without downloading", () => {
    const version = bundled!.replace(/^postgresql_|\.zip$/g, "");
    const r = sb.cli(["install", "postgresql", version], { ...withBinaries, DBNGIN_APP: "/Applications/DBngin.app" });
    expect(r.code).toBe(0);
    expect(r.err).toContain("from the DBngin app");
    expect(existsSync(join(binaries, "postgresql", version, "bin/postgres"))).toBe(true);
    expect(existsSync(join(binaries, "postgresql", "__MACOSX"))).toBe(false);
  }, 120_000);
});
