import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Service } from "./registry";
import { CliError, must, pidAlive, processCommand, run, xmlEscape } from "./util";

/**
 * Everything that differs between database engines. The plist templates copy the
 * ones inside the DBngin app byte for byte (apart from values), so services this
 * tool creates are indistinguishable from ones the app creates.
 */
export interface Engine {
  type: string; // as stored in the service list
  dir: string; // folder name under Engines/ and the binaries root
  defaultPort: number;
  label(s: Service): string;
  plist(s: Service): string;
  /** PID of this service's server process, if it is running (checked against the data folder). */
  runningPid(s: Service): number | null;
  /** Whether the server accepts connections. */
  ready(s: Service): boolean;
  /** Create an empty data folder for a new service. */
  init(s: Service): void;
  /** Signal that makes the server shut down quickly but cleanly. */
  stopSignal: NodeJS.Signals;
  url(s: Service, db?: string): string;
  env(s: Service, db?: string): Record<string, string>;
  /** Interactive client command line. */
  client(s: Service, db?: string): string[];
  logFiles(s: Service): string[];
  /** Whether `dbngin db …` works for this engine. */
  databases: boolean;
}

const bin = (s: Service, name: string) => join(s.Binaries, "bin", name);
export const plistPath = (e: Engine, s: Service) => join(s.DBPath, `${e.label(s)}.plist`);
const hasConfigFile = (s: Service) => !!s.ConfigPath && s.ConfigPath.startsWith("/") && existsSync(s.ConfigPath);

const postgres: Engine = {
  type: "PostgreSQL",
  dir: "postgresql",
  defaultPort: 5432,
  stopSignal: "SIGINT", // PostgreSQL "fast" shutdown: disconnect clients, checkpoint, exit
  databases: true,
  label: (s) => `com.tinyapp.DBngin.postgresql-${s.ID}`,
  plist(s) {
    const x = xmlEscape;
    const config = hasConfigFile(s)
      ? `\n      <string>-c</string>\n      <string>config_file=${x(s.ConfigPath)}</string>`
      : "";
    return `  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>KeepAlive</key>
    <true/>
    <key>Label</key>
    <string>${x(this.label(s))}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${x(bin(s, "postgres"))}</string>
      <string>-D</string>
      <string>${x(s.DBPath)}</string>
      <string>-p</string>
      <string>${x(s.Port)}</string>${config}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${x(s.Binaries)}</string>
    <key>StandardOutPath</key>
    <string>${x(s.DBPath)}/postgres_out.log</string>
    <key>StandardErrorPath</key>
    <string>${x(s.DBPath)}/postgres_err.log</string>
  </dict>
  </plist>`;
  },
  runningPid(s) {
    const pidFile = join(s.DBPath, "postmaster.pid");
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]);
    if (!pid || !pidAlive(pid)) return null;
    // A stale pid file can point at an unrelated process that reused the PID.
    return processCommand(pid)?.includes(s.DBPath) ? pid : null;
  },
  ready: (s) => run([bin(s, "pg_isready"), "-q", "-h", "127.0.0.1", "-p", s.Port, "-U", "postgres"]).code === 0,
  init(s) {
    // Same settings the app uses: superuser "postgres", no password from this Mac.
    must([bin(s, "initdb"), "-D", s.DBPath, "-U", "postgres", "-A", "trust", "--encoding=UTF-8", "--locale=en_US.UTF-8"]);
  },
  url: (s, db = "postgres") => `postgresql://postgres@127.0.0.1:${s.Port}/${encodeURIComponent(db)}`,
  env: (s, db = "postgres") => ({
    DATABASE_URL: postgres.url(s, db),
    PGHOST: "127.0.0.1",
    PGPORT: s.Port,
    PGUSER: "postgres",
    PGDATABASE: db,
  }),
  client: (s, db = "postgres") => [bin(s, "psql"), "-h", "127.0.0.1", "-p", s.Port, "-U", "postgres", "-d", db],
  logFiles: (s) => [join(s.DBPath, "postgres_err.log"), join(s.DBPath, "postgres_out.log")],
};

const redis: Engine = {
  type: "Redis",
  dir: "redis",
  defaultPort: 6379,
  stopSignal: "SIGTERM", // Redis saves (if configured) and exits
  databases: false,
  label: (s) => `com.tinyapp.DBngin.redis-server-${s.ID}`,
  plist(s) {
    const x = xmlEscape;
    const config = hasConfigFile(s) ? `\n      <string>${x(s.ConfigPath)}</string>` : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>Label</key>
    <string>${x(this.label(s))}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${x(bin(s, "redis-server"))}</string>${config}
      <string>--pidfile redis.pid</string>
      <string>--port ${x(s.Port)}</string>
      <string>--daemonize no</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${x(s.DBPath)}</string>
    <key>StandardErrorPath</key>
    <string>${x(s.DBPath)}/redis.log</string>
    <key>StandardOutPath</key>
    <string>${x(s.DBPath)}/redis.log</string>
  </dict>
</plist>`;
  },
  runningPid(s) {
    const pidFile = join(s.DBPath, "redis.pid");
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!pid || !pidAlive(pid)) return null;
    // Redis's command line is "redis-server *:<port>", without the data folder.
    const cmd = processCommand(pid) ?? "";
    return cmd.includes("redis-server") && cmd.includes(`:${s.Port}`) ? pid : null;
  },
  ready: (s) => run([bin(s, "redis-cli"), "-p", s.Port, "ping"]).stdout.trim() === "PONG",
  init(s) {
    mkdirSync(s.DBPath, { recursive: true });
  },
  url: (s, db = "0") => `redis://127.0.0.1:${s.Port}/${db}`,
  env: (s, db = "0") => ({ REDIS_URL: redis.url(s, db), REDIS_HOST: "127.0.0.1", REDIS_PORT: s.Port }),
  client: (s, db = "0") => [bin(s, "redis-cli"), "-p", s.Port, "-n", db],
  logFiles: (s) => [join(s.DBPath, "redis.log")],
};

export const ENGINES: Engine[] = [postgres, redis];

/** Engines the app supports that this tool can list but not manage yet. */
export const UNSUPPORTED_TYPES: Record<string, string> = { MySQL: "mysql", MariaDB: "mariadb" };

export function engineFor(s: Service): Engine {
  const e = ENGINES.find((e) => e.type === s.Type);
  if (!e) {
    throw new CliError(
      `${s.Type} services are not supported yet`,
      `DBngin runs ${s.Type} as a system service under its own user, which needs admin rights. Use the DBngin app for these.`,
    );
  }
  return e;
}

/** Accepts "postgres", "pg", "postgresql", "PostgreSQL", "redis". */
export function engineByName(name: string): Engine {
  const n = name.toLowerCase();
  const e = ENGINES.find((e) => e.dir === n || e.type.toLowerCase() === n || (e === postgres && (n === "pg" || n === "postgres")));
  if (!e) {
    const msg = UNSUPPORTED_TYPES[name] || Object.values(UNSUPPORTED_TYPES).includes(n) ? `${name} is not supported yet` : `unknown engine "${name}"`;
    throw new CliError(msg, "Supported engines: postgres, redis.");
  }
  return e;
}

export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
