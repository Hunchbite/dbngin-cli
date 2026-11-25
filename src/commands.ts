import { existsSync } from "node:fs";
import type { ParseArgsConfig } from "node:util";
import { availableVersions, install, installedVersions } from "./binaries";
import type { Ctx } from "./cli";
import { ENGINES, engineByName, engineFor, isDir, plistPath } from "./engines";
import { c, json, note, table } from "./output";
import { appRunning, loadServices, openApp, quitApp, type Service } from "./registry";
import { portOwner } from "./ports";
import { readPlist } from "./plist";
import * as svc from "./service";
import { CliError, interactive, must, run } from "./util";

export interface Command {
  usage: string;
  summary: string;
  minArgs: number;
  options?: NonNullable<ParseArgsConfig["options"]>;
  run(ctx: Ctx): Promise<number | void> | number | void;
}

const restartAppOpt = { "restart-app": { type: "boolean" as const } };
const timeoutOpt = { timeout: { type: "string" as const } };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const flag = (v: unknown) => v === true;

function portArg(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new CliError(`invalid port "${v}"`, undefined, 2);
  return n;
}

function onOff(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === "on" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "no") return false;
  throw new CliError(`expected on or off, got "${v}"`, undefined, 2);
}

const timeoutMs = (ctx: Ctx) => (str(ctx.values.timeout) ? Number(ctx.values.timeout) * 1000 : 30_000);

function stateLabel(st: svc.ServiceStatus): string {
  switch (st.state) {
    case "running":
      return st.managed ? c.green("running") : c.green("running") + c.dim(" (outside launchd)");
    case "failing":
      return c.red("failing");
    case "missing":
      return c.red("missing data");
    case "unsupported":
      return c.dim("n/a");
    default:
      return c.dim("stopped");
  }
}

function describe(s: Service) {
  const st = svc.status(s);
  const e = ENGINES.find((e) => e.type === s.Type);
  return {
    name: s.Name,
    id: s.ID,
    type: s.Type,
    version: s.Version,
    port: Number(s.Port),
    state: st.state,
    pid: st.pid,
    managedByLaunchd: st.managed,
    autostart: s.AutoStartup,
    url: e ? e.url(s) : null,
    dataDir: s.DBPath,
    binaries: s.Binaries,
    logs: e ? e.logFiles(s) : [],
  };
}

function confirm(question: string, yes: boolean): void {
  if (yes) return;
  if (!process.stdin.isTTY) throw new CliError("refusing to continue without confirmation", "Re-run with --yes.");
  const answer = prompt(`${question} [y/N]`);
  if (!answer || !/^y(es)?$/i.test(answer.trim())) throw new CliError("cancelled");
}

/** A running PostgreSQL service, for the db commands. */
function runningPostgres(query: string): Service {
  const s = svc.resolveService(query);
  const e = engineFor(s);
  if (!e.databases) throw new CliError(`database commands only work with PostgreSQL; "${s.Name}" is ${s.Type}`);
  if (svc.status(s).state !== "running") throw new CliError(`"${s.Name}" is not running`, `Start it with \`dbngin start ${svc.quote(s.Name)}\`.`);
  return s;
}

const pgBin = (s: Service, name: string) => `${s.Binaries}/bin/${name}`;
const pgConn = (s: Service) => ["-h", "127.0.0.1", "-p", s.Port, "-U", "postgres"];

function sql(s: Service, query: string, db = "postgres"): string[][] {
  const out = must([pgBin(s, "psql"), ...pgConn(s), "-d", db, "-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", query]);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

// --- Commands --------------------------------------------------------------------------

export const commands: Record<string, Command> = {
  ls: {
    usage: "ls [--engine postgres|redis] [--running] [--json]",
    summary: "List every service with its real state (read from launchd and pid files, not the app's cached status).",
    minArgs: 0,
    options: { engine: { type: "string" }, running: { type: "boolean" } },
    run(ctx) {
      let services = loadServices();
      if (str(ctx.values.engine)) {
        const e = engineByName(str(ctx.values.engine)!);
        services = services.filter((s) => s.Type === e.type);
      }
      let rows = services.map(describe);
      if (flag(ctx.values.running)) rows = rows.filter((r) => r.state === "running");
      if (ctx.values.json) return json(rows);
      if (rows.length === 0) return note("No services.");
      console.log(
        table(
          ["NAME", "ENGINE", "VERSION", "PORT", "STATE", "PID", "ID"],
          rows.map((r) => [
            c.bold(r.name),
            r.type,
            r.version,
            String(r.port),
            stateLabel({ state: r.state, pid: r.pid, managed: r.managedByLaunchd }),
            r.pid ? String(r.pid) : "",
            c.dim(r.id.slice(0, 8)),
          ]),
        ),
      );
    },
  },

  info: {
    usage: "info <svc> [--json]",
    summary: "Show a service's details, connection URL and file locations.",
    minArgs: 1,
    run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      const d = describe(s);
      if (ctx.values.json) return json(d);
      const st = svc.status(s);
      const lines: [string, string][] = [
        ["Name", c.bold(d.name)],
        ["ID", d.id],
        ["Engine", `${d.type} ${d.version}`],
        ["Port", String(d.port)],
        ["State", stateLabel(st) + (d.pid ? c.dim(`  pid ${d.pid}`) : "")],
        ["Starts with app", d.autostart ? "yes" : "no"],
        ["URL", d.url ?? c.dim("n/a")],
        ["Data", d.dataDir],
        ["Binaries", d.binaries],
        ...d.logs.map((l, i): [string, string] => [i === 0 ? "Logs" : "", l]),
      ];
      for (const [k, v] of lines) console.log(`${c.dim(k.padEnd(16))}${v}`);
    },
  },

  start: {
    usage: "start <svc>… [--timeout seconds]",
    summary: "Start services through launchd and wait until each accepts connections.",
    minArgs: 1,
    options: timeoutOpt,
    async run(ctx) {
      for (const q of ctx.positionals) {
        const s = svc.resolveService(q);
        const r = await svc.start(s, timeoutMs(ctx));
        note(r.already ? `${s.Name}: already running (pid ${r.status.pid})` : `${c.green("✓")} ${s.Name} started on port ${s.Port} (pid ${r.status.pid})`);
      }
    },
  },

  stop: {
    usage: "stop <svc>… [--timeout seconds]",
    summary: "Stop services cleanly (PostgreSQL fast shutdown) and unload them from launchd. Also stops servers started outside DBngin.",
    minArgs: 1,
    options: timeoutOpt,
    async run(ctx) {
      for (const q of ctx.positionals) {
        const s = svc.resolveService(q);
        const r = await svc.stop(s, timeoutMs(ctx));
        note(r.already ? `${s.Name}: already stopped` : `${c.green("✓")} ${s.Name} stopped`);
      }
    },
  },

  restart: {
    usage: "restart <svc>… [--timeout seconds]",
    summary: "Stop, then start services.",
    minArgs: 1,
    options: timeoutOpt,
    async run(ctx) {
      for (const q of ctx.positionals) {
        const s = svc.resolveService(q);
        await svc.stop(s, timeoutMs(ctx));
        const r = await svc.start(s, timeoutMs(ctx));
        note(`${c.green("✓")} ${s.Name} restarted on port ${s.Port} (pid ${r.status.pid})`);
      }
    },
  },

  create: {
    usage: "create <name> [--engine postgres|redis] [--version V] [--port N] [--autostart] [--start] [--db NAME]… [--restart-app] [--json]",
    summary:
      "Create a service exactly as the app would. Defaults: PostgreSQL, the newest installed version, the first free port. " +
      "A version that isn't installed is unpacked from the app or downloaded. --db creates databases (implies --start).",
    minArgs: 1,
    options: {
      engine: { type: "string", short: "e" },
      version: { type: "string" },
      port: { type: "string", short: "p" },
      autostart: { type: "boolean" },
      start: { type: "boolean" },
      db: { type: "string", multiple: true },
      ...restartAppOpt,
    },
    async run(ctx) {
      const e = engineByName(str(ctx.values.engine) ?? "postgres");
      const dbs = (ctx.values.db as string[] | undefined) ?? [];
      if (dbs.length && !e.databases) throw new CliError(`--db only works with PostgreSQL`, undefined, 2);
      const s = await svc.create({
        engine: e,
        name: ctx.positionals.join(" "),
        version: str(ctx.values.version),
        port: portArg(ctx.values.port),
        autostart: flag(ctx.values.autostart),
        restartApp: flag(ctx.values["restart-app"]),
        log: note,
      });
      note(`${c.green("✓")} created ${c.bold(s.Name)} — ${s.Type} ${s.Version} on port ${s.Port} (${s.ID.slice(0, 8)})`);
      if (flag(ctx.values.start) || dbs.length) {
        await svc.start(s);
        note(`${c.green("✓")} started`);
        for (const db of dbs) {
          must([pgBin(s, "createdb"), ...pgConn(s), db]);
          note(`${c.green("✓")} database ${db}`);
        }
      }
      if (ctx.values.json) return json(describe(s));
      console.log(e.url(s, dbs[0]));
    },
  },

  set: {
    usage: "set <svc> [--name NAME] [--port N] [--autostart on|off] [--restart-app]",
    summary: "Change a service's name, port, or whether the app starts it at launch. A running service picks up a new port on restart.",
    minArgs: 1,
    options: { name: { type: "string" }, port: { type: "string", short: "p" }, autostart: { type: "string" }, ...restartAppOpt },
    async run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      const opts = { name: str(ctx.values.name), port: portArg(ctx.values.port), autostart: onOff(ctx.values.autostart) };
      if (opts.name === undefined && opts.port === undefined && opts.autostart === undefined) {
        throw new CliError("nothing to change", "Pass --name, --port or --autostart.", 2);
      }
      const running = svc.status(s).state === "running";
      const t = await svc.update(s, { ...opts, restartApp: flag(ctx.values["restart-app"]) });
      note(`${c.green("✓")} updated ${c.bold(t.Name)} (port ${t.Port}, autostart ${t.AutoStartup ? "on" : "off"})`);
      if (running && opts.port !== undefined && String(opts.port) !== s.Port) {
        note(c.yellow(`It is still running on port ${s.Port}; \`dbngin restart ${svc.quote(t.Name)}\` moves it.`));
      }
    },
  },

  rm: {
    usage: "rm <svc> [--yes] [--purge] [--restart-app]",
    summary: "Stop a service, remove it from DBngin, and move its data folder to the Trash. --purge deletes the data instead.",
    minArgs: 1,
    options: { yes: { type: "boolean", short: "y" }, purge: { type: "boolean" }, ...restartAppOpt },
    async run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      const what = flag(ctx.values.purge) ? "and PERMANENTLY DELETE its data" : "and move its data to the Trash";
      confirm(`Remove ${s.Type} service "${s.Name}" (port ${s.Port}) ${what}?`, flag(ctx.values.yes));
      const r = await svc.remove(s, { purge: flag(ctx.values.purge), restartApp: flag(ctx.values["restart-app"]) });
      note(`${c.green("✓")} removed ${s.Name}${r.trashedTo ? c.dim(` — data in ${r.trashedTo}`) : ""}`);
    },
  },

  url: {
    usage: "url <svc> [db]",
    summary: "Print the connection URL (PostgreSQL database defaults to postgres, Redis database to 0).",
    minArgs: 1,
    run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      console.log(engineFor(s).url(s, ctx.positionals[1]));
    },
  },

  env: {
    usage: "env <svc> [db] [--export] [--json]",
    summary: "Print connection variables (DATABASE_URL and PG* for PostgreSQL, REDIS_URL for Redis). Use `eval \"$(dbngin env <svc> --export)\"`.",
    minArgs: 1,
    options: { export: { type: "boolean" } },
    run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      const vars = engineFor(s).env(s, ctx.positionals[1]);
      if (ctx.values.json) return json(vars);
      const prefix = flag(ctx.values.export) ? "export " : "";
      for (const [k, v] of Object.entries(vars)) console.log(`${prefix}${k}=${flag(ctx.values.export) ? `'${v}'` : v}`);
    },
  },

  shell: {
    usage: "shell <svc> [db] [-- client args]",
    summary: "Open psql or redis-cli on the service. Arguments after -- go to the client, e.g. `dbngin shell app mydb -- -c 'select 1'`.",
    minArgs: 1,
    run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      if (svc.status(s).state !== "running") throw new CliError(`"${s.Name}" is not running`, `Start it with \`dbngin start ${svc.quote(s.Name)}\`.`);
      return interactive([...engineFor(s).client(s, ctx.positionals[1]), ...ctx.passthrough]);
    },
  },

  db: {
    usage: "db <ls|create|drop|dump|restore> <svc> [args]",
    summary: "Manage databases on a running PostgreSQL service.",
    minArgs: 2,
    options: {
      owner: { type: "string" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      output: { type: "string", short: "o" },
      create: { type: "boolean" },
    },
    run(ctx) {
      const [action, query, ...args] = ctx.positionals;
      const s = runningPostgres(query!);
      switch (action) {
        case "ls":
        case "list": {
          const rows = sql(
            s,
            "select datname, pg_get_userbyid(datdba), pg_database_size(datname), pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1",
          );
          if (ctx.values.json) return json(rows.map(([name, owner, bytes]) => ({ name, owner, bytes: Number(bytes), url: engineFor(s).url(s, name) })));
          return console.log(table(["DATABASE", "OWNER", "SIZE"], rows.map(([n, o, , size]) => [c.bold(n!), o!, size!])));
        }
        case "create": {
          const name = args[0];
          if (!name) throw new CliError("which database?", "Usage: dbngin db create <svc> <name> [--owner ROLE]", 2);
          const owner = str(ctx.values.owner);
          must([pgBin(s, "createdb"), ...pgConn(s), ...(owner ? ["-O", owner] : []), name]);
          note(`${c.green("✓")} created database ${name}`);
          return console.log(engineFor(s).url(s, name));
        }
        case "drop": {
          const name = args[0];
          if (!name) throw new CliError("which database?", "Usage: dbngin db drop <svc> <name> [--yes] [--force]", 2);
          confirm(`Drop database "${name}" on ${s.Name}? This cannot be undone.`, flag(ctx.values.yes));
          sql(s, `drop database ${quoteIdent(name)}${flag(ctx.values.force) ? " with (force)" : ""}`);
          return note(`${c.green("✓")} dropped database ${name}`);
        }
        case "dump": {
          const name = args[0];
          if (!name) throw new CliError("which database?", "Usage: dbngin db dump <svc> <db> [-o file]", 2);
          const out = str(ctx.values.output) ?? `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.dump`;
          must([pgBin(s, "pg_dump"), ...pgConn(s), "-Fc", "-f", out, name]);
          return note(`${c.green("✓")} dumped ${name} to ${out}`);
        }
        case "restore": {
          const [name, file] = args;
          if (!name || !file) throw new CliError("which database and file?", "Usage: dbngin db restore <svc> <db> <file> [--create]", 2);
          if (!existsSync(file)) throw new CliError(`file not found: ${file}`);
          if (flag(ctx.values.create)) must([pgBin(s, "createdb"), ...pgConn(s), name]);
          const r = run([pgBin(s, "pg_restore"), ...pgConn(s), "-d", name, "--no-owner", file]);
          if (r.code !== 0) throw new CliError(`pg_restore reported errors:\n${r.stderr.trim()}`);
          return note(`${c.green("✓")} restored ${file} into ${name}`);
        }
        default:
          throw new CliError(`unknown db action "${action}"`, "Use ls, create, drop, dump or restore.", 2);
      }
    },
  },

  logs: {
    usage: "logs <svc> [-n lines] [-f]",
    summary: "Show the end of the server log, or follow it with -f.",
    minArgs: 1,
    options: { lines: { type: "string", short: "n" }, follow: { type: "boolean", short: "f" } },
    run(ctx) {
      const s = svc.resolveService(ctx.positionals[0]!);
      const files = engineFor(s).logFiles(s).filter(existsSync);
      if (!files.length) throw new CliError(`"${s.Name}" has no log files yet`);
      return interactive(["tail", "-n", str(ctx.values.lines) ?? "50", ...(flag(ctx.values.follow) ? ["-F"] : []), files[0]!]);
    },
  },

  versions: {
    usage: "versions [engine] [--available] [--json]",
    summary: "List installed engine versions, or with --available, the versions in DBngin's catalog that run on this Mac.",
    minArgs: 0,
    options: { available: { type: "boolean" } },
    async run(ctx) {
      const engines = ctx.positionals[0] ? [engineByName(ctx.positionals[0])] : ENGINES;
      const result: Record<string, { installed: string[]; available?: string[] }> = {};
      for (const e of engines) {
        result[e.dir] = { installed: installedVersions(e) };
        if (flag(ctx.values.available)) result[e.dir]!.available = (await availableVersions(e)).map((v) => v.Version);
      }
      if (ctx.values.json) return json(result);
      for (const [dir, v] of Object.entries(result)) {
        console.log(c.bold(dir));
        if (v.available) {
          for (const ver of v.available) console.log(`  ${ver}${v.installed.includes(ver) ? c.green("  installed") : ""}`);
          for (const ver of v.installed.filter((x) => !v.available!.includes(x))) console.log(`  ${ver}${c.green("  installed")}${c.dim("  (no longer in catalog)")}`);
        } else {
          console.log(v.installed.length ? v.installed.map((x) => `  ${x}`).join("\n") : c.dim("  none"));
        }
      }
    },
  },

  install: {
    usage: "install <engine> <version>",
    summary: "Unpack an engine version into /Users/Shared/DBngin (from the app's bundled archive, or downloaded from DBngin).",
    minArgs: 2,
    async run(ctx) {
      const e = engineByName(ctx.positionals[0]!);
      const dir = await install(e, ctx.positionals[1]!, note);
      note(`${c.green("✓")} ${e.type} ${ctx.positionals[1]} at ${dir}`);
    },
  },

  doctor: {
    usage: "doctor [--json]",
    summary: "Check for port clashes, missing data or binaries, duplicate names and servers that keep crashing.",
    minArgs: 0,
    run(ctx) {
      const services = loadServices();
      const issues: { level: "error" | "warn" | "info"; service?: string; message: string }[] = [];
      const add = (level: "error" | "warn" | "info", message: string, service?: string) => issues.push({ level, message, service });

      const statuses = new Map(services.map((s) => [s.ID, svc.status(s)]));
      const ourPids = new Set([...statuses.values()].map((st) => st.pid).filter(Boolean));

      for (const s of services) {
        const st = statuses.get(s.ID)!;
        if (st.state === "unsupported") {
          add("info", `${s.Type} services are listed but not managed by this tool`, s.Name);
          continue;
        }
        if (st.state === "missing") add("error", `data folder is missing: ${s.DBPath}`, s.Name);
        if (st.state === "failing") add("error", "launchd keeps restarting it but the server won't stay up; see `dbngin logs`", s.Name);
        if (!isDir(`${s.Binaries}/bin`)) add("error", `${s.Type} ${s.Version} binaries are missing; run \`dbngin install ${engineFor(s).dir} ${s.Version}\``, s.Name);
        if (st.state === "running" && !st.managed) add("info", "running outside launchd (started by pg_ctl or similar); `dbngin stop` still works", s.Name);
        if (isDir(s.DBPath) && st.state !== "missing") {
          const p = plistPath(engineFor(s), s);
          if (existsSync(p)) {
            const args = readPlist<{ ProgramArguments?: string[] }>(p).ProgramArguments ?? [];
            if (!args.some((a) => a === s.Port || a === `--port ${s.Port}`)) add("warn", `launchd plist uses a different port than the service list (${s.Port}); fixed on next start`, s.Name);
          }
        }
      }

      const byPort = new Map<string, Service[]>();
      for (const s of services) byPort.set(s.Port, [...(byPort.get(s.Port) ?? []), s]);
      for (const [port, list] of byPort) {
        if (list.length > 1) add("warn", `${list.length} services share port ${port} (${list.map((s) => s.Name).join(", ")}); only one can run at a time`);
        const owner = portOwner(Number(port));
        if (owner && !ourPids.has(owner.pid)) {
          add("warn", `port ${port} is taken by ${owner.command}${owner.pid ? ` (pid ${owner.pid})` : ""}, which is not a DBngin service, so ${list.map((s) => s.Name).join(", ")} can't start`);
        }
      }

      const byName = new Map<string, number>();
      for (const s of services) byName.set(s.Name.toLowerCase(), (byName.get(s.Name.toLowerCase()) ?? 0) + 1);
      for (const [name, n] of byName) if (n > 1) add("warn", `${n} services are named "${name}"; refer to them by ID prefix`);

      if (ctx.values.json) return json(issues);
      if (!issues.length) return console.log(`${c.green("✓")} no problems found in ${services.length} services`);
      const icon = { error: c.red("✗"), warn: c.yellow("!"), info: c.dim("i") };
      for (const i of issues) console.log(`${icon[i.level]} ${i.service ? `${c.bold(i.service)}: ` : ""}${i.message}`);
      return issues.some((i) => i.level === "error") ? 1 : 0;
    },
  },

  app: {
    usage: "app <open|quit|status>",
    summary: "Open, quit or check the DBngin app. Services keep running when the app quits.",
    minArgs: 1,
    async run(ctx) {
      switch (ctx.positionals[0]) {
        case "open":
          openApp(false);
          return;
        case "quit":
          await quitApp();
          return note(`${c.green("✓")} DBngin app closed`);
        case "status":
          return console.log(appRunning() ? "open" : "closed");
        default:
          throw new CliError(`unknown app action "${ctx.positionals[0]}"`, "Use open, quit or status.", 2);
      }
    },
  },
};

commands.psql = { ...commands.shell!, usage: "psql <svc> [db] [-- psql args]" };
commands.list = commands.ls!;
commands.remove = commands.rm!;
