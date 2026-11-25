import { homedir } from "node:os";
import { join } from "node:path";

// Every location can be overridden with an environment variable. The tests use this
// to run against a throwaway directory instead of the real DBngin data.

/** DBngin's Application Support folder: the service list and each service's data. */
export const appSupportDir = () =>
  process.env.DBNGIN_HOME ?? join(homedir(), "Library/Application Support/com.tinyapp.DBngin");

/** Where DBngin unpacks engine binaries, one folder per engine and version. */
export const binariesRoot = () => process.env.DBNGIN_BINARIES ?? "/Users/Shared/DBngin";

/** The service list DBngin shows in its window. */
export const registryPath = () => join(appSupportDir(), "Data/DBEngines.plist");

/** The copy this tool saves before every change to the service list. */
export const registryBackupPath = () => join(appSupportDir(), "Data/DBEngines.cli-backup.plist");

export const enginesDir = () => join(appSupportDir(), "Engines");

export const appBundle = () => process.env.DBNGIN_APP ?? "/Applications/DBngin.app";

export const catalogUrl = () => process.env.DBNGIN_CATALOG_URL ?? "https://dbngin.com/osx/engines";

/** Process name of the DBngin app (tests point this at a stand-in process). */
export const appProcess = () => process.env.DBNGIN_APP_PROCESS ?? "DBngin";

/** Where `rm` moves data folders. */
export const trashDir = () => process.env.DBNGIN_TRASH ?? join(homedir(), ".Trash");
