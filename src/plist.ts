import { existsSync, renameSync, writeFileSync } from "node:fs";
import { CliError, must } from "./util";

/** Read any plist (XML or binary) as JSON using macOS's plutil. */
export function readPlist<T>(path: string): T {
  if (!existsSync(path)) throw new CliError(`file not found: ${path}`);
  const json = must(["plutil", "-convert", "json", "-o", "-", path]);
  return JSON.parse(json) as T;
}

/** Write JSON-compatible data as an XML plist, atomically. */
export function writePlist(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data));
  must(["plutil", "-convert", "xml1", tmp]);
  must(["plutil", "-lint", "-s", tmp]);
  renameSync(tmp, path);
}
