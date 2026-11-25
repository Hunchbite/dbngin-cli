---
name: dbngin
description: Runs local PostgreSQL and Redis on macOS through DBngin with the `dbngin` CLI. Use when a project needs a local database or its connection string (DATABASE_URL, REDIS_URL), when a local Postgres or Redis refuses connections or needs starting or stopping, or when creating, resetting, dumping or inspecting a local development database on a Mac.
---

# dbngin

`dbngin` controls the local database servers of the DBngin app (macOS) from the shell. A service is one server: one engine, version, port and data folder, holding any number of databases. Refer to a service by its name (case and punctuation ignored, so `my-app` finds "My App"), an ID prefix, or its port. Add `--json` when you need to parse output. `dbngin <command> --help` has every option.

## Before you start

Run `command -v dbngin`. If it is missing, ask the user before installing it with `bun install -g github:Hunchbite/dbngin-cli` (needs Bun). If `/Applications/DBngin.app` is missing, tell the user: DBngin is a free download from dbngin.com, and installing apps is their call.

## Getting a database for a project

This is the usual job. Default flow:

1. `dbngin ls --json`. If a service clearly belongs to this project (its name matches the project or repo), use it and start it if it is stopped.
2. Otherwise create one named after the project: `dbngin create <project> --db <project> --restart-app`. It picks the newest installed PostgreSQL and a free port, starts the server, creates the database and prints its URL.
3. `dbngin env <service> <db>` prints `DATABASE_URL` and the `PG*` variables. Before writing them into the project's `.env`, check what is there: an existing `DATABASE_URL` that points somewhere else (a remote or staging database) should only be replaced if the user agrees.
4. Check it works: `dbngin shell <service> <db> -- -c 'select 1'`.

For Redis, use `--engine redis` and `REDIS_URL` from `dbngin env`. To pin a version, add `--version` (see `dbngin versions --available`).

## How it differs from what you might expect

- **The app must be closed to change the service list.** `create`, `set` and `rm` edit a file the open DBngin app would overwrite, so they refuse while it is open. `--restart-app` closes the app and reopens it afterwards; running databases keep running, so this is safe to use.
- **Port 5432 is often taken** by something outside DBngin (Homebrew Postgres, Docker). `start` refuses and names what holds the port. Don't stop processes that aren't DBngin services; move this service instead with `dbngin set <service> --port <free port> --restart-app`, then start it. `dbngin doctor` lists every clash.
- **No passwords.** The superuser is `postgres` with trust authentication on 127.0.0.1: `postgresql://postgres@127.0.0.1:<port>/<db>`.
- **The state in `ls` is real.** It comes from launchd and the server's pid file, not the app's cached status. "running (outside launchd)" means something like `pg_ctl` started it; `dbngin stop` still works.
- **`stop` disconnects clients immediately** (PostgreSQL fast shutdown). If the user has a dev server or migration running against the database, mention it before stopping.
- **MySQL and MariaDB services are listed but not managed** (DBngin runs them as system services that need admin rights). Point the user to the DBngin app for those.

## Commands that lose data

Ask the user first, and say what will be lost:

- `dbngin rm <service>` removes the service and moves its data folder to the Trash. `--purge` deletes it permanently; use that only when the user asks for permanent deletion.
- `dbngin db drop <service> <db>` cannot be undone. `--force` also disconnects anyone using the database.

Both need `--yes` when there is no terminal to confirm in; pass it once the user has agreed. Before dropping or resetting a database that holds data, offer a dump: `dbngin db dump <service> <db> -o <file>` (restore with `dbngin db restore <service> <db> <file> --create`).

## When something is wrong

- Connection refused: `dbngin ls` shows whether the service is stopped or on a different port than the app expects.
- A service won't start: the error includes the last log lines; `dbngin logs <service> -n 100` shows more.
- `dbngin doctor` checks everything at once: port clashes, missing data folders or engine versions, servers that keep crashing. Exit code 1 means it found errors.
- An engine version is missing: `dbngin install <engine> <version>`.

## Command summary

| Task | Command |
|---|---|
| List services | `dbngin ls [--running] [--json]` |
| Details of one | `dbngin info <service> [--json]` |
| Start, stop, restart | `dbngin start\|stop\|restart <service>…` |
| New service | `dbngin create <name> [--engine postgres\|redis] [--version V] [--port N] [--db NAME]… [--start] [--restart-app]` |
| Rename, move port, autostart | `dbngin set <service> [--name N] [--port N] [--autostart on\|off] [--restart-app]` |
| Connection string / variables | `dbngin url <service> [db]` · `dbngin env <service> [db] [--export\|--json]` |
| SQL or redis-cli | `dbngin shell <service> [db] -- <client args>` |
| Databases | `dbngin db ls\|create\|drop\|dump\|restore <service> …` |
| Health | `dbngin doctor` · `dbngin logs <service> [-n N] [-f]` |
