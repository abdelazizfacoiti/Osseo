import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LEGACY_CONFIG_DIRNAME, LEGACY_HOME_DIRNAME } from "./legacy.js";

/** Single public version used by packaged components and diagnostics. */
export const OSSEO_VERSION = "0.1.0";
export const OSSEO_CONFIG_SCHEMA_VERSION = 1 as const;

export function defaultOsseoHome(homeDir = os.homedir()): string {
  const home = path.join(homeDir, ".osseo");
  // An install from before the rename keeps its data where it is until the new folder exists.
  const legacy = path.join(homeDir, LEGACY_HOME_DIRNAME);
  return !existsSync(home) && existsSync(legacy) ? legacy : home;
}

export function defaultPublicConfigPath(homeDir = os.homedir(), options: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {}): string {
  if ((options.platform ?? process.platform) === "win32") {
    // Windows keeps per-user settings under %APPDATA% (Roaming); fall back to the standard folder under the home directory.
    const env = options.env ?? process.env;
    const appData = env.APPDATA !== undefined && env.APPDATA !== "" ? env.APPDATA : path.win32.join(homeDir, "AppData", "Roaming");
    return path.win32.join(appData, "osseo", "config.json");
  }
  const current = path.join(homeDir, ".config", "osseo", "config.json");
  const legacy = path.join(homeDir, ".config", LEGACY_CONFIG_DIRNAME, "config.json");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function legacyConfigPath(homeDir = os.homedir()): string {
  return path.join(defaultOsseoHome(homeDir), "config.json");
}

export function redactLocalPath(value: string, homeDir = os.homedir()): string {
  const normalized = path.resolve(value);
  const home = path.resolve(homeDir);
  if (normalized === home) return "[home]";
  if (normalized.startsWith(`${home}${path.sep}`)) return `[home]${normalized.slice(home.length)}`;
  return "[external-path]";
}

export function normalizeSha256(value: string): string {
  const digest = value.trim().split(/\s+/u)[0] ?? "";
  if (!/^[a-f0-9]{64}$/iu.test(digest)) throw new Error("release_checksum_invalid");
  return digest.toLowerCase();
}

export function sha256Buffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256Buffer(await readFile(filePath));
}

export async function readSha256Sidecar(filePath: string): Promise<string | undefined> {
  try {
    return normalizeSha256(await readFile(`${filePath}.sha256`, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "release_checksum_invalid") throw error;
    return undefined;
  }
}
