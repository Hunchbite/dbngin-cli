import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineByName, engineFor } from "../src/engines";
import { readPlist, writePlist } from "../src/plist";
import { findService, loadServices, type Service, updateServices } from "../src/registry";
import { compareVersions, normalizeName, xmlEscape } from "../src/util";

const home = mkdtempSync(join(tmpdir(), "dbngin-unit-"));

function svc(over: Partial<Service>): Service {
  const id = over.ID ?? "AAAAAAAA-0000-0000-0000-000000000000";
  const dir = join(home, "Engines/postgresql", id);
  return {
    LogPath: dir,
    DisableBinLog: true,
    Source: "https://files.dbngin.com/binaries/postgresql/17.0.zip",
    Binaries: "/Users/Shared/DBngin/postgresql/17.0",
    AutoStartup: false,
    Name: "app",
    ID: id,
    ConfigPath: "Select a file...",
    Pid: dir,
    Port: "5432",
    SocketPath: "",
    Version: "17.0",
    Status: "stopped",
    Type: "PostgreSQL",
    DBPath: dir,
    ...over,
  };
}

const services = [
  svc({ ID: "3B7C91D2-5E4A-4F1B-9C2D-7A8E6F5D4C3B", Name: "My App", Port: "8432" }),
  svc({ ID: "40AB1350-1111-1111-1111-111111111111", Name: "Indexer" }),
  svc({ ID: "02B32C00-2222-2222-2222-222222222222", Name: "Indexer" }),
  svc({ ID: "9D1E2F3A-4B5C-4D6E-8F70-1A2B3C4D5E6F", Name: "cache", Type: "Redis", Port: "6379" }),
];

beforeAll(() => {
  process.env.DBNGIN_HOME = home;
  process.env.DBNGIN_IGNORE_APP = "1";
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("findService", () => {
  test("by exact name, loose name, ID prefix and port", () => {
    expect(findService(services, "My App").Port).toBe("8432");
    expect(findService(services, "my-app").Port).toBe("8432");
    expect(findService(services, "3b7c").Name).toBe("My App");
    expect(findService(services, "6379").Name).toBe("cache");
    expect(findService(services, ":8432").Name).toBe("My App");
  });

  test("ambiguous names list the candidates", () => {
    expect(() => findService(services, "indexer")).toThrow(/matches 2 services/);
    expect(findService(services, "40ab").ID).toStartWith("40AB1350");
  });

  test("unknown names fail clearly", () => {
    expect(() => findService(services, "nope")).toThrow(/no service matches/);
  });
});

describe("helpers", () => {
  test("compareVersions orders numerically and ignores suffixes", () => {
    const sorted = ["9.5.0", "17.0", "18.4_arm", "16.2", "18.1"].sort((a, b) => compareVersions(b, a));
    expect(sorted).toEqual(["18.4_arm", "18.1", "17.0", "16.2", "9.5.0"]);
  });

  test("normalizeName", () => {
    expect(normalizeName("Data Store")).toBe(normalizeName("data-store"));
  });

  test("xmlEscape", () => {
    expect(xmlEscape(`a&b<c>"d"`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;");
  });

  test("engineByName aliases", () => {
    for (const n of ["pg", "postgres", "postgresql", "PostgreSQL"]) expect(engineByName(n).type).toBe("PostgreSQL");
    expect(engineByName("redis").type).toBe("Redis");
    expect(() => engineByName("mysql")).toThrow(/not supported yet/);
  });
});

describe("plists", () => {
  test("generated launchd plists are valid and carry the port", () => {
    for (const s of [services[0]!, services[3]!]) {
      const file = join(home, `${s.ID}.plist`);
      writeFileSync(file, engineFor(s).plist(s));
      const p = readPlist<{ Label: string; ProgramArguments: string[] }>(file);
      expect(p.Label).toBe(engineFor(s).label(s));
      expect(p.ProgramArguments.some((a) => a === s.Port || a === `--port ${s.Port}`)).toBe(true);
    }
  });

  test("paths with spaces and ampersands survive", () => {
    const s = svc({ DBPath: "/tmp/a & b/<x>", Name: "weird" });
    const file = join(home, "weird.plist");
    writeFileSync(file, engineFor(s).plist(s));
    expect(readPlist<{ ProgramArguments: string[] }>(file).ProgramArguments).toContain("/tmp/a & b/<x>");
  });

  test("writePlist round-trips the service list", () => {
    const file = join(home, "list.plist");
    writePlist(file, services);
    expect(readPlist<Service[]>(file)).toEqual(services);
    expect(readFileSync(file, "utf8")).toStartWith("<?xml");
  });
});

describe("service list writes", () => {
  test("updateServices saves changes and keeps a backup", async () => {
    mkdirSync(join(home, "Data"), { recursive: true });
    writePlist(join(home, "Data/DBEngines.plist"), services);
    await updateServices((list) => {
      list[0]!.Port = "9999";
    });
    expect(loadServices()[0]!.Port).toBe("9999");
    expect(readPlist<Service[]>(join(home, "Data/DBEngines.cli-backup.plist"))[0]!.Port).toBe("8432");
  });

  test("a failing change writes nothing", async () => {
    await expect(
      updateServices((list) => {
        list[0]!.Port = "1";
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(loadServices()[0]!.Port).toBe("9999");
  });
});
