// Guards against DBngin changing its file formats: compares every launchd plist the
// installed app wrote with what this tool would write for the same service.
// Read-only. Runs only where DBngin has services; skipped elsewhere.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ENGINES, plistPath } from "../src/engines";
import { readPlist } from "../src/plist";
import type { Service } from "../src/registry";

// The real service list, regardless of DBNGIN_HOME overrides used by other tests.
const registry = join(homedir(), "Library/Application Support/com.tinyapp.DBngin/Data/DBEngines.plist");
const all = existsSync(registry) ? readPlist<Service[]>(registry) : [];
const services = all.filter((s) => ENGINES.some((e) => e.type === s.Type));
const withPlist = services.filter((s) => existsSync(plistPath(ENGINES.find((e) => e.type === s.Type)!, s)));

describe.skipIf(withPlist.length === 0)("matches the DBngin app's own files", () => {
  test("launchd plists are byte-for-byte identical", () => {
    const mismatched = withPlist
      .filter((s) => {
        const e = ENGINES.find((e) => e.type === s.Type)!;
        return readFileSync(plistPath(e, s), "utf8") !== e.plist(s);
      })
      .map((s) => `${s.Type} ${s.ID.slice(0, 8)}`);
    expect(mismatched).toEqual([]);
  });

  test("service-list entries have the fields this tool writes", () => {
    const fields = ["ID", "Name", "Type", "Version", "Port", "Status", "AutoStartup", "Binaries", "DBPath", "LogPath", "Pid", "Source", "ConfigPath", "SocketPath", "DisableBinLog"];
    for (const s of all) expect(Object.keys(s).sort()).toEqual([...fields].sort());
  });
});
