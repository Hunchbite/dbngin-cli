import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "./engines";
import { appBundle, binariesRoot, catalogUrl } from "./paths";
import { CliError, compareVersions, must, run } from "./util";

export interface CatalogEntry {
  Version: string;
  Source: string;
  Archs: string; // "ARM", "Intel" or "Intel | ARM"
  MinimumSystemVersion: string;
}

export const binariesDir = (e: Engine, version: string) => join(binariesRoot(), e.dir, version);

/** Versions already unpacked on this Mac, newest first. */
export function installedVersions(e: Engine): string[] {
  const root = join(binariesRoot(), e.dir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((v) => existsSync(join(root, v, "bin")))
    .sort((a, b) => compareVersions(b, a));
}

/** The version list the DBngin app downloads, keyed by engine type. */
export async function fetchCatalog(): Promise<Record<string, CatalogEntry[]>> {
  let res: Response;
  try {
    res = await fetch(`${catalogUrl()}?t=${Date.now()}`);
  } catch (e) {
    throw new CliError(`could not reach ${catalogUrl()}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new CliError(`${catalogUrl()} returned HTTP ${res.status}`);
  const body = (await res.json()) as { Versions?: Record<string, CatalogEntry[]> };
  return body.Versions ?? {};
}

const macOSVersion = () => run(["sw_vers", "-productVersion"]).stdout.trim();

export function compatible(entry: CatalogEntry): boolean {
  const arch = process.arch === "arm64" ? "ARM" : "Intel";
  return entry.Archs.includes(arch) && compareVersions(macOSVersion(), entry.MinimumSystemVersion) >= 0;
}

/** Catalog versions that run on this Mac, newest first. */
export async function availableVersions(e: Engine): Promise<CatalogEntry[]> {
  const catalog = await fetchCatalog();
  return (catalog[e.type] ?? []).filter(compatible).sort((a, b) => compareVersions(b.Version, a.Version));
}

/**
 * Unpack an engine version into the binaries folder, the same place the app uses.
 * Prefers the archive bundled inside DBngin.app and downloads otherwise.
 */
export async function install(e: Engine, version: string, log: (msg: string) => void): Promise<string> {
  const dest = binariesDir(e, version);
  if (existsSync(join(dest, "bin"))) return dest;

  let archive = join(appBundle(), "Contents/Resources", `${e.dir}_${version}.zip`);
  let downloaded = false;
  if (!existsSync(archive)) {
    const entry = (await fetchCatalog())[e.type]?.find((c) => c.Version === version);
    if (!entry) throw new CliError(`${e.type} ${version} is not in DBngin's catalog`, `See \`dbngin versions ${e.dir} --available\`.`);
    if (!compatible(entry)) throw new CliError(`${e.type} ${version} does not run on this Mac (${entry.Archs}, macOS ${entry.MinimumSystemVersion}+)`);
    archive = join(tmpdir(), `dbngin-${e.dir}-${version}-${process.pid}.zip`);
    log(`Downloading ${entry.Source} …`);
    const res = await fetch(entry.Source);
    if (!res.ok) throw new CliError(`download failed: HTTP ${res.status} from ${entry.Source}`);
    await Bun.write(archive, res);
    downloaded = true;
  } else {
    log(`Unpacking ${e.type} ${version} from the DBngin app …`);
  }

  try {
    const parent = join(binariesRoot(), e.dir);
    mkdirSync(parent, { recursive: true });
    must(["unzip", "-q", "-o", archive, "-x", "__MACOSX/*", "-d", parent]);
  } finally {
    if (downloaded) rmSync(archive, { force: true });
  }
  if (!existsSync(join(dest, "bin"))) {
    throw new CliError(`unpacked the archive but ${dest}/bin is missing`, `Check what landed in ${join(binariesRoot(), e.dir)}.`);
  }
  return dest;
}
