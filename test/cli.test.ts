// CLI behaviour and edge cases that need no running database and no DBngin install:
// argument errors, lookups, broken or unusual service lists, the app guard, rm safety,
// stale pid files and doctor. Each test works in its own throwaway folder.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { entry, fakeApp, sandbox } from "./helpers";

const sandboxes: ReturnType<typeof sandbox>[] = [];
const fresh = (env: Record<string, string> = {}) => {
  const sb = sandbox(env);
  sandboxes.push(sb);
  return sb;
};
afterAll(() => sandboxes.forEach((s) => s.cleanup()));

describe("arguments", () => {
  const sb = fresh();

  test("help and version", () => {
    expect(sb.ok("help").out).toContain("dbngin");
    expect(sb.ok("--help").out).toContain("Services");
    expect(sb.ok("--version").out).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sb.ok("start", "--help").out).toContain("Usage: dbngin start");
  });

  test("usage errors exit 2", () => {
    expect(sb.fails(2, "frobnicate").err).toContain('unknown command "frobnicate"');
    expect(sb.fails(2, "ls", "--bogus").err).toContain("Usage: dbngin ls");
    expect(sb.fails(2, "start").err).toContain("missing arguments");
    expect(sb.fails(2, "db", "ls").err).toContain("missing arguments");
  });
});

describe("empty or broken service list", () => {
  test("no service list yet", () => {
    const sb = fresh();
    expect(sb.ok("ls").err).toContain("No services.");
    expect(sb.json("ls")).toEqual([]);
    expect(sb.ok("doctor").out).toContain("no problems found in 0 services");
    expect(sb.fails(1, "start", "anything").err).toContain('no service matches "anything"');
  });

  test("a corrupt service list fails cleanly", () => {
    const sb = fresh();
    mkdirSync(join(sb.home, "Data"), { recursive: true });
    writeFileSync(sb.registryFile, "this is not a plist");
    const r = sb.fails(1, "ls");
    expect(r.err).toContain("plutil failed");
    expect(r.err).not.toContain("    at "); // no stack trace
  });

  test("a service list that isn't a list", () => {
    const sb = fresh();
    sb.seed({ not: "an array" } as never);
    expect(sb.fails(1, "ls").err).toContain("unexpected format");
  });
});

describe("finding services", () => {
  const sb = fresh();
  const a = entry(sb, { Name: "My App", Port: "8432" });
  const b = entry(sb, { Name: "Indexer", Port: "7001" });
  const c = entry(sb, { Name: "Indexer", Port: "7002" });
  sb.seed([a, b, c]);

  test("by name, loose name, ID prefix and port", () => {
    expect(sb.ok("url", "My App").out).toBe("postgresql://postgres@127.0.0.1:8432/postgres");
    expect(sb.ok("url", "my-app").out).toContain(":8432/");
    expect(sb.ok("url", a.ID.slice(0, 8).toLowerCase()).out).toContain(":8432/");
    expect(sb.ok("url", "8432").out).toContain(":8432/");
    expect(sb.ok("url", ":7001").out).toContain(":7001/");
  });

  test("ambiguous names exit 1 and list the candidates", () => {
    const r = sb.fails(1, "info", "indexer");
    expect(r.err).toContain("matches 2 services");
    expect(r.err).toContain(b.ID.slice(0, 8));
    expect(r.err).toContain(c.ID.slice(0, 8));
  });

  test("url encodes database names", () => {
    expect(sb.ok("url", "my-app", "my db").out).toBe("postgresql://postgres@127.0.0.1:8432/my%20db");
  });

  test("env in all three formats", () => {
    expect(sb.ok("env", "my-app", "shop").out).toContain("PGDATABASE=shop");
    expect(sb.ok("env", "my-app", "--export").out).toContain("export PGPORT='8432'");
    expect(sb.json("env", "my-app")).toMatchObject({ PGHOST: "127.0.0.1", PGPORT: "8432", PGUSER: "postgres" });
  });
});

describe("set validation", () => {
  const sb = fresh();
  sb.seed([entry(sb, { Name: "one" }), entry(sb, { Name: "two" })]);

  test("rejects nothing-to-change, bad ports and bad on/off", () => {
    expect(sb.fails(2, "set", "one").err).toContain("nothing to change");
    expect(sb.fails(2, "set", "one", "--port", "70000").err).toContain("invalid port");
    expect(sb.fails(2, "set", "one", "--port", "abc").err).toContain("invalid port");
    expect(sb.fails(2, "set", "one", "--autostart", "maybe").err).toContain("expected on or off");
  });

  test("rejects a duplicate name", () => {
    expect(sb.fails(1, "set", "one", "--name", "TWO").err).toContain('a service named "two" already exists');
  });

  test("changes name, port and autostart, and keeps a backup", () => {
    sb.ok("set", "one", "--name", "uno", "--port", "6000", "--autostart", "on");
    expect(sb.json("info", "uno")).toMatchObject({ name: "uno", port: 6000, autostart: true });
    expect(existsSync(join(sb.home, "Data/DBEngines.cli-backup.plist"))).toBe(true);
  });
});

describe("unsupported engines", () => {
  const sb = fresh();
  sb.seed([entry(sb, { Name: "legacy", Type: "MySQL", Version: "8.0.33", Port: "3306" })]);

  test("MySQL is listed but not managed", () => {
    expect(sb.json("ls")[0]).toMatchObject({ name: "legacy", state: "unsupported", url: null });
    expect(sb.ok("ls").out).toContain("n/a");
    expect(sb.fails(1, "start", "legacy").err).toContain("MySQL services are not supported yet");
    expect(sb.fails(1, "url", "legacy").err).toContain("not supported yet");
    expect(sb.ok("doctor").out).toContain("not managed by this tool");
  });

  test("create refuses unsupported or unknown engines", () => {
    expect(sb.fails(1, "create", "x", "--engine", "mysql").err).toContain("not supported yet");
    expect(sb.fails(1, "create", "x", "--engine", "oracle").err).toContain('unknown engine "oracle"');
  });

  test("create with no installed versions explains what to do", () => {
    const empty = fresh({ DBNGIN_BINARIES: join(sb.root, "no-binaries") });
    expect(empty.fails(1, "create", "x", "--engine", "redis").err).toContain("no Redis version is installed");
  });
});

describe("state detection", () => {
  test("missing data folder", () => {
    const sb = fresh();
    sb.seed([entry(sb, { Name: "ghost" })]);
    expect(sb.json("ls")[0].state).toBe("missing");
    expect(sb.fails(1, "start", "ghost").err).toContain("data folder");
    const d = sb.cli(["doctor"]);
    expect(d.code).toBe(1);
    expect(d.out).toContain("data folder is missing");
  });

  test("missing engine binaries", () => {
    const sb = fresh();
    const s = entry(sb, { Name: "old", Version: "9.9.9", Binaries: "/nonexistent/postgresql/9.9.9" });
    mkdirSync(s.DBPath, { recursive: true });
    sb.seed([s]);
    const r = sb.fails(1, "start", "old");
    expect(r.err).toContain("PostgreSQL 9.9.9 is not installed");
    expect(r.err).toContain("dbngin install postgresql 9.9.9");
    expect(sb.cli(["doctor"]).out).toContain("binaries are missing");
  });

  test("stale pid files pointing at unrelated processes are ignored", () => {
    const sb = fresh();
    const pg = entry(sb, { Name: "pg" });
    const rd = entry(sb, { Name: "rd", Type: "Redis", Port: "6390" });
    for (const s of [pg, rd]) mkdirSync(s.DBPath, { recursive: true });
    writeFileSync(join(pg.DBPath, "postmaster.pid"), `${process.pid}\n${pg.DBPath}\n`); // alive, but it's us
    writeFileSync(join(rd.DBPath, "redis.pid"), `${process.pid}\n`);
    sb.seed([pg, rd]);
    expect(sb.json("ls").map((s: { state: string }) => s.state)).toEqual(["stopped", "stopped"]);
    writeFileSync(join(pg.DBPath, "postmaster.pid"), "999999\n"); // dead pid
    expect(sb.json("info", "pg").state).toBe("stopped");
  });

  test("commands that need a running server say so", () => {
    const sb = fresh();
    const pg = entry(sb, { Name: "pg" });
    const rd = entry(sb, { Name: "rd", Type: "Redis", Port: "6390" });
    for (const s of [pg, rd]) mkdirSync(s.DBPath, { recursive: true });
    sb.seed([pg, rd]);
    expect(sb.fails(1, "db", "ls", "pg").err).toContain('"pg" is not running');
    expect(sb.fails(1, "shell", "pg").err).toContain('"pg" is not running');
    expect(sb.fails(1, "db", "ls", "rd").err).toContain("only work with PostgreSQL");
    expect(sb.ok("stop", "pg").err).toContain("already stopped");
    expect(sb.fails(1, "logs", "pg").err).toContain("no log files yet");
  });
});

describe("doctor", () => {
  test("shared ports, duplicate names, foreign listeners and plist drift", () => {
    const sb = fresh();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const busy = String(server.port);
      const a = entry(sb, { Name: "dup", Port: busy });
      const b = entry(sb, { Name: "dup", Port: busy });
      const drift = entry(sb, { Name: "drift", Port: "7777" });
      for (const s of [a, b, drift]) mkdirSync(s.DBPath, { recursive: true });
      // A plist that still says 5555 while the list says 7777.
      writeFileSync(
        join(drift.DBPath, `com.tinyapp.DBngin.postgresql-${drift.ID}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>x</string><key>ProgramArguments</key><array><string>postgres</string><string>-p</string><string>5555</string></array></dict></plist>`,
      );
      sb.seed([a, b, drift]);
      const issues = sb.json<{ level: string; message: string }[]>("doctor");
      const text = issues.map((i) => i.message).join("\n");
      expect(text).toContain(`2 services share port ${busy}`);
      expect(text).toContain(`port ${busy} is taken by`);
      expect(text).toContain('2 services are named "dup"');
      expect(text).toContain("different port than the service list (7777)");
    } finally {
      server.stop(true);
    }
  });
});

describe("rm", () => {
  test("needs --yes without a terminal", () => {
    const sb = fresh();
    sb.seed([entry(sb, { Name: "keep" })]);
    expect(sb.fails(1, "rm", "keep").err).toContain("without confirmation");
    expect(sb.services()).toHaveLength(1);
  });

  test("moves data to the Trash by default", () => {
    const sb = fresh();
    const s = entry(sb, { Name: "old one" });
    mkdirSync(s.DBPath, { recursive: true });
    writeFileSync(join(s.DBPath, "marker"), "data");
    sb.seed([s]);
    const r = sb.ok("rm", "old-one", "--yes");
    expect(r.err).toContain("data in");
    expect(existsSync(s.DBPath)).toBe(false);
    expect(sb.services()).toHaveLength(0);
    const trashed = Bun.spawnSync(["ls", sb.trash]).stdout.toString();
    expect(trashed).toContain(`DBngin old one ${s.ID.slice(0, 8)}`);
  });

  test("--purge deletes the data", () => {
    const sb = fresh();
    const s = entry(sb, { Name: "gone" });
    mkdirSync(s.DBPath, { recursive: true });
    sb.seed([s]);
    sb.ok("rm", "gone", "--purge", "--yes");
    expect(existsSync(s.DBPath)).toBe(false);
    expect(Bun.spawnSync(["ls", sb.trash]).stdout.toString()).toBe("");
  });

  test("never deletes a data folder outside DBngin's own folder", () => {
    const sb = fresh();
    const outside = join(sb.root, "elsewhere");
    const s = entry(sb, { Name: "outside" });
    const moved = { ...s, DBPath: join(outside, s.ID) };
    mkdirSync(moved.DBPath, { recursive: true });
    sb.seed([moved]);
    const r = sb.fails(1, "rm", "outside", "--purge", "--yes");
    expect(r.err).toContain("left its data alone");
    expect(existsSync(moved.DBPath)).toBe(true);
    expect(sb.services()).toHaveLength(0);
  });
});

describe("app guard", () => {
  test("refuses list changes while the app is open; --restart-app closes it first", async () => {
    const sb = fresh();
    const proc = fakeApp(sb.root, "FakeDBnginApp");
    await Bun.sleep(300);
    expect(proc.exitCode).toBeNull(); // the stand-in is alive
    const env = { DBNGIN_IGNORE_APP: "0", DBNGIN_APP_PROCESS: "FakeDBnginApp" };
    try {
      sb.seed([entry(sb, { Name: "guarded" })]);
      const refused = sb.cli(["set", "guarded", "--port", "6001"], env);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("the DBngin app is open");
      expect(sb.services()[0]!.Port).toBe("5432");
      expect(sb.cli(["rm", "guarded", "--yes"], env).code).toBe(1);
      expect(sb.cli(["create", "new"], env).code).toBe(1);

      const done = sb.cli(["set", "guarded", "--port", "6001", "--restart-app"], env);
      expect(done.code).toBe(0);
      expect(done.err).toContain("could not reopen the DBngin app"); // no real app in the sandbox
      expect(sb.services()[0]!.Port).toBe("6001");
      expect(await proc.exited).not.toBe(0); // the stand-in app was closed
    } finally {
      proc.kill();
    }
  });

  test("app status reports the stand-in", async () => {
    const sb = fresh();
    expect(sb.cli(["app", "status"], { DBNGIN_IGNORE_APP: "0", DBNGIN_APP_PROCESS: "NoSuchProcessX" }).out).toBe("closed");
    expect(sb.fails(2, "app", "explode").err).toContain("unknown app action");
  });
});
