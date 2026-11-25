#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from "node:util";
import pkg from "../package.json";
import { commands, type Command } from "./commands";
import { c } from "./output";
import { CliError } from "./util";

const HELP = `${c.bold("dbngin")} ${pkg.version} — control DBngin's database services from the terminal

${c.bold("Services")}
  ls                         list services with their real running state
  info <svc>                 details, connection URL and file locations
  start <svc>…               start services and wait until they accept connections
  stop <svc>…                stop services cleanly
  restart <svc>…             stop, then start
  create <name>              create a new service      (--engine postgres|redis, --version, --port, --start, --db)
  set <svc>                  change a service          (--name, --port, --autostart on|off)
  rm <svc>                   remove a service; data goes to the Trash (--purge deletes it)

${c.bold("Connecting")}
  url <svc> [db]             connection URL
  env <svc> [db]             connection variables      (--export for shell, --json)
  shell <svc> [db]           open psql / redis-cli     (alias: psql; extra args after --)

${c.bold("Databases")} (PostgreSQL)
  db ls <svc>                list databases with sizes
  db create <svc> <name>     create a database         (--owner)
  db drop <svc> <name>       drop a database           (--yes, --force)
  db dump <svc> <db>         pg_dump in custom format  (-o file)
  db restore <svc> <db> <file>   pg_restore a dump    (--create)

${c.bold("Engines and the app")}
  versions [engine]          installed engine versions (--available for DBngin's catalog)
  install <engine> <version> download and unpack an engine version
  logs <svc>                 show the server log       (-n lines, -f to follow)
  doctor                     find port clashes, missing data and other problems
  app open|quit|status       control the DBngin app

<svc> is a service name (case and punctuation ignored), an ID prefix, or a port.
Add --json to ls, info, env, db ls, versions and doctor for machine-readable output.
Changes to the service list need the DBngin app closed; --restart-app closes and reopens it.
`;

export interface Ctx {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** Arguments after a bare "--". */
  passthrough: string[];
}

function parse(cmd: Command, argv: string[]): Ctx {
  const dd = argv.indexOf("--");
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  const config: ParseArgsConfig = {
    args: own,
    allowPositionals: true,
    strict: true,
    options: { ...cmd.options, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  };
  try {
    const { values, positionals } = parseArgs(config);
    return { values: values as Ctx["values"], positionals, passthrough };
  } catch (e) {
    throw new CliError((e as Error).message.replace(/^.*?: /, ""), `Usage: dbngin ${cmd.usage}`, 2);
  }
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "-h" || name === "--help") {
    console.log(HELP);
    return 0;
  }
  if (name === "-v" || name === "--version" || name === "version") {
    console.log(pkg.version);
    return 0;
  }
  if (process.platform !== "darwin") throw new CliError("DBngin only runs on macOS");

  const cmd = commands[name];
  if (!cmd) throw new CliError(`unknown command "${name}"`, "Run `dbngin help` for the list.", 2);
  const ctx = parse(cmd, rest);
  if (ctx.values.help) {
    console.log(`Usage: dbngin ${cmd.usage}\n\n${cmd.summary}`);
    return 0;
  }
  if (ctx.positionals.length < cmd.minArgs) throw new CliError("missing arguments", `Usage: dbngin ${cmd.usage}`, 2);
  return (await cmd.run(ctx)) ?? 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof CliError) {
      console.error(`${c.red("error:")} ${e.message}`);
      if (e.hint) console.error(c.dim(e.hint));
      process.exit(e.exitCode);
    }
    console.error(e);
    process.exit(1);
  },
);
