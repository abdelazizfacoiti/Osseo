import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { InstallLayout } from "./install-layout.js";
import { activateJunctionRelease } from "./junction-release.js";
import { extractZip, listZip, ZipError } from "./zip.js";

/*
 * `osseo update --archive <file>.zip`: the Windows release. Node only: the
 * checksum was checked by the caller, the zip is read with node:zlib, and the
 * release is switched with directory junctions (see junction-release.ts).
 */

export interface ZipUpdateInput {
  archive: string;
  checksum: string;
  apply: boolean;
  layout: InstallLayout;
  /** A folder for the unpacked release; it is removed afterwards. */
  tmpDir: string;
}

export type ZipUpdateResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

const TOP = /^osseo-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-x64$/u;

export async function updateFromZip(input: ZipUpdateInput): Promise<ZipUpdateResult> {
  if (input.layout.platform !== "win32") return { ok: false, error: "zip_archive_windows_only" };
  const buffer = await readFile(input.archive);
  let tops: Set<string>;
  try {
    tops = new Set(listZip(buffer).map((entry) => entry.name.split("/")[0]!));
  } catch (error) {
    return { ok: false, error: error instanceof ZipError ? `archive_invalid:${error.code}` : "archive_invalid" };
  }
  if (tops.size !== 1) return { ok: false, error: "archive_layout_invalid" };
  const first = [...tops][0]!;
  const match = TOP.exec(first);
  if (match === null) return { ok: false, error: "release_version_invalid" };
  const version = match[1]!;
  const preview = { archive: path.basename(input.archive), version, checksum: input.checksum, checksumVerified: true, backupRequired: true, atomicSwitch: false, rollbackOnHealthFailure: true };
  if (!input.apply) return { ok: true, data: { preview: true, ...preview } };

  const extraction = await mkdtemp(path.join(input.tmpDir, "osseo-update-"));
  try {
    try {
      await extractZip(buffer, extraction);
    } catch (error) {
      return { ok: false, error: error instanceof ZipError ? `archive_extract_failed:${error.code}` : "archive_extract_failed" };
    }
    const staged = path.join(extraction, first);
    const healthy = await Promise.all([stat(path.join(staged, "version.json")), stat(path.join(staged, "packages", "mcp-server", "dist", "index.js")), stat(path.join(staged, "bin", "osseo.mjs"))]).then(() => true, () => false);
    if (!healthy) return { ok: false, error: "archive_health_check_failed" };
    const manifest = JSON.parse(await readFile(path.join(staged, "version.json"), "utf8")) as { version?: unknown; platform?: unknown; architecture?: unknown };
    if (manifest.version !== version) return { ok: false, error: "release_version_mismatch" };
    if (manifest.platform !== "windows" || manifest.architecture !== "x64") return { ok: false, error: "release_platform_mismatch" };
    try {
      const switched = await activateJunctionRelease(input.layout, staged, version);
      return { ok: true, data: { applied: true, version, checksumVerified: true, rollbackAvailable: switched.previousVersion !== undefined } };
    } catch (error) {
      return { ok: false, error: error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "release_switch_failed" };
    }
  } finally {
    await rm(extraction, { recursive: true, force: true }).catch(() => undefined);
  }
}
