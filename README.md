# dbngin-cli

A command-line tool for [DBngin](https://dbngin.com), the free macOS app for running local PostgreSQL, MySQL and Redis servers.

DBngin is GUI-only: there is no official CLI ([TablePlus/DBngin#42](https://github.com/TablePlus/DBngin/issues/42), open since 2020), and its AppleScript dictionary can only open the app. `dbngin` lets you script all of it: list, start, stop, create, rename and remove services, get connection strings, and manage PostgreSQL databases. It works directly with DBngin's own files, so the app and the CLI see the same services.

> **Unofficial.** Not affiliated with or endorsed by TablePlus. Built by reading how DBngin stores its data (see [How it works](#how-it-works)); a future DBngin release could change that.

```console
$ dbngin ls
NAME        ENGINE      VERSION   PORT  STATE    PID    ID
api         PostgreSQL  18.4_arm  8432  running  41207  3B7C91D2
analytics   PostgreSQL  17.0      7432  stopped         A91F0C37
cache       Redis       7.0.0     6379  stopped         9D1E2F3A

$ dbngin create shop --db shop --db shop_test
✓ created shop — PostgreSQL 18.4_arm on port 5433 (4C1D2E9A)
✓ started
✓ database shop
✓ database shop_test
postgresql://postgres@127.0.0.1:5433/shop

$ eval "$(dbngin env shop shop --export)"   # DATABASE_URL, PGHOST, PGPORT, PGUSER, PGDATABASE
```

## Install

Needs macOS, [DBngin](https://dbngin.com) and [Bun](https://bun.sh).

```sh
bun install -g github:Hunchbite/dbngin-cli
```

Or build a standalone binary:

```sh
git clone https://github.com/Hunchbite/dbngin-cli && cd dbngin-cli
bun install && bun run build      # → dist/dbngin
cp dist/dbngin ~/.local/bin/
```

## Use it from an AI coding agent

The repo includes an [agent skill](skills/dbngin/SKILL.md) that teaches Claude Code (and other agents that read skills) when and how to use `dbngin`: finding or creating a project's database, wiring up `DATABASE_URL` without overwriting a remote one, working around port clashes, and asking before anything that loses data. Install the CLI first, then the skill:

```sh
# any agent that supports skills (Claude Code, Codex, Cursor, …) via skills.sh
npx skills add Hunchbite/dbngin-cli -g

# or as a Claude Code plugin
/plugin marketplace add Hunchbite/dbngin-cli
/plugin install dbngin@dbngin-cli

# or by hand
git clone https://github.com/Hunchbite/dbngin-cli ~/src/dbngin-cli
ln -s ~/src/dbngin-cli/skills/dbngin ~/.claude/skills/dbngin
```

Then just ask for what you need. The agent picks the skill up on its own:

> Set up a local Postgres for this project and put the connection string in .env.
>
> My local Postgres won't start, can you fix it?
>
> Make a fresh copy of the shop database so I can test the migration on it.

## Commands

| Command | What it does |
|---|---|
| `dbngin ls [--engine pg\|redis] [--running]` | List services with their **real** state (DBngin's own cached status is often wrong) |
| `dbngin info <svc>` | Details, URL, data and log locations |
| `dbngin start <svc>…` | Start and wait until it accepts connections. Refuses if the port is taken, and says by what |
| `dbngin stop <svc>…` | Clean shutdown (PostgreSQL fast mode). Also stops servers started outside DBngin, e.g. with `pg_ctl` |
| `dbngin restart <svc>…` | Stop, then start |
| `dbngin create <name>` | New service, set up exactly as the app does it. `--engine postgres\|redis`, `--version`, `--port` (default: first free), `--start`, `--db NAME` (repeatable), `--autostart` |
| `dbngin set <svc>` | `--name`, `--port`, `--autostart on\|off` |
| `dbngin rm <svc>` | Stop, remove from DBngin, move the data folder to the Trash. `--purge` deletes it instead |
| `dbngin url <svc> [db]` | Connection URL |
| `dbngin env <svc> [db]` | Connection variables. `--export` for `eval`, `--json` |
| `dbngin shell <svc> [db] [-- args]` | `psql` or `redis-cli` (alias `psql`) |
| `dbngin db ls\|create\|drop\|dump\|restore <svc> …` | PostgreSQL databases: list with sizes, create (`--owner`), drop (`--force`), `pg_dump -Fc`, `pg_restore` |
| `dbngin logs <svc> [-n N] [-f]` | Server log |
| `dbngin versions [engine] [--available]` | Installed engine versions, or DBngin's catalog for this Mac |
| `dbngin install <engine> <version>` | Unpack an engine version (from the app bundle, or download it) |
| `dbngin doctor` | Port clashes, ports taken by other software, missing data or binaries, duplicate names, crash loops |
| `dbngin app open\|quit\|status` | Control the app |

`<svc>` can be the service name (case and punctuation ignored, so `my-app` finds "My App"), the start of its ID, or its port. `--json` works on `ls`, `info`, `env`, `db ls`, `versions`, `doctor` and `create`. Run `dbngin <command> --help` for details.

### Changes to the service list need the app closed

`create`, `set` and `rm` edit DBngin's service list. The open app keeps its own copy and would overwrite the change, so these commands refuse while it is open. Close it with `dbngin app quit` first, or add `--restart-app` to close and reopen it automatically. **Closing the app does not stop your databases.** Start, stop and database commands work with the app open or closed.

### Supported engines

PostgreSQL and Redis are fully supported. MySQL and MariaDB services are listed, but DBngin runs them as system daemons under the `_mysql`/`_mariadb` users, which needs admin rights. Manage those in the app for now.

## How it works

Everything DBngin does maps to plain files and `launchd`:

| | Location |
|---|---|
| Service list | `~/Library/Application Support/com.tinyapp.DBngin/Data/DBEngines.plist`: one entry per service (ID, name, type, version, port, data path, auto-start) |
| Service data | `…/com.tinyapp.DBngin/Engines/<engine>/<ID>/`: the database files, plus the service's launchd plist `com.tinyapp.DBngin.<engine>-<ID>.plist` |
| Engine binaries | `/Users/Shared/DBngin/<engine>/<version>/bin` (PostgreSQL builds include PostGIS). The builds have this path baked in and only run from there |
| Version catalog | `https://dbngin.com/osx/engines`; archives come from `files.dbngin.com/binaries/…` |
| Running | Each service is a per-user launchd agent: `launchctl bootstrap gui/$UID <plist>` starts it, `launchctl bootout` stops it |
| PostgreSQL | `initdb -U postgres -A trust --encoding=UTF-8 --locale=en_US.UTF-8`: superuser `postgres`, no password from this Mac |

`dbngin` writes launchd plists byte-for-byte identical to the app's, and service-list entries with the same fields, so services created here show up in the app and the other way round. Before every change to the service list it saves a copy to `Data/DBEngines.cli-backup.plist`.

## Development

```sh
bun install
bun test                          # unit + CLI tests: no DBngin needed, ~4 s
DBNGIN_E2E=1 bun test             # + end-to-end with real servers, ~70 s
bun run typecheck
```

| File | Covers |
|---|---|
| `test/unit.test.ts` | Service lookup, version sorting, plist generation and escaping, atomic list writes with backup |
| `test/cli.test.ts` | Every command's argument errors and exit codes; empty and corrupt service lists; ambiguous names; unsupported engines; missing data or binaries; stale pid files; `doctor` findings; `rm` confirmation, Trash and path safety; the open-app guard and `--restart-app` |
| `test/e2e.test.ts` | Real PostgreSQL and Redis through launchd: full lifecycle, defaults, restart and port moves, two services on one port, stopping with clients connected, dropping a database in use, logs, start timeouts and crash loops, launchd restarting a crashed server, servers started with `pg_ctl`, ports held by other programs, `rm` of a running service, downloads and the app's bundled archives |
| `test/parity.test.ts` | Your installed DBngin's own files still match what this tool writes, to catch format changes in a DBngin update. Read-only; skipped when DBngin has no services |

Every test runs in a throwaway folder (`DBNGIN_HOME`, `DBNGIN_TRASH`) and never touches your real services. One exception is deliberate: DBngin's engine builds only run from `/Users/Shared/DBngin`, so the download test installs a Redis version there, as the app would, and removes it afterwards.

## License

MIT
