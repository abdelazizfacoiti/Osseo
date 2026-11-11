import { cp, lstat, mkdir, readdir, readFile, rename, rm, symlink, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import type { InstallLayout } from "./install-layout.js";

/*
 * Switching the active release by replacing directory links (junctions on
 * Windows; `symlink(..., "junction")` is a plain symlink on other systems, which
 * is how the tests run). Nothing is renamed or deleted inside a release that is
 * in use: only the two links change. The switch is two steps (remove the old
 * link, create the new one), so it is not atomic; a failure puts the old link
 * back.
 */

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

async function exists(target: string): Promise<boolean> {
  return await lstat(target).then(() => true, () => false);
}

async function isLink(target: string): Promise<boolean> {
  return await lstat(target).then((stat) => stat.isSymbolicLink(), () => false);
}

/** The version recorded in `<dir>/version.json`, or undefined. */
export async function releaseVersion(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, "version.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" && VERSION.test(manifest.version) ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Removes a link without touching what it points to. */
async function removeLink(target: string): Promise<void> {
  if (!(await isLink(target))) return;
  try {
    await unlink(target);
  } catch {
    await rmdir(target);
  }
}

async function moveDirectory(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, { recursive: true, force: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function makeLink(target: string, link: string): Promise<void> {
  await symlink(target, link, "junction");
}

export interface ActivateResult {
  version: string;
  previousVersion?: string;
}

/** Moves `staged` to releases/<version>, makes `current` a link to it and `current.previous` a link to the old release. */
export async function activateJunctionRelease(layout: InstallLayout, staged: string, version: string): Promise<ActivateResult> {
  if (!VERSION.test(version)) throw new Error("release_version_invalid");
  const destination = path.join(layout.releases, version);
  await mkdir(layout.releases, { recursive: true });
  const oldVersion = await releaseVersion(layout.current);
  const currentWasLink = await isLink(layout.current);
  if (await exists(destination)) {
    try {
      await rm(destination, { recursive: true, force: true });
    } catch {
      throw new Error("release_replace_failed");
    }
  }
  await moveDirectory(staged, destination);

  const keepOld = oldVersion !== undefined && oldVersion !== version && (await exists(path.join(layout.releases, oldVersion)));
  if (currentWasLink) {
    if (keepOld) {
      await removeLink(layout.previous);
      await rm(layout.previous, { recursive: true, force: true });
      await makeLink(path.join(layout.releases, oldVersion), layout.previous);
    }
    await removeLink(layout.current);
  } else if (await exists(layout.current)) {
    // A plain folder from an older layout: keep it as the previous release.
    await removeLink(layout.previous);
    await rm(layout.previous, { recursive: true, force: true });
    await rename(layout.current, layout.previous);
  }
  try {
    await makeLink(destination, layout.current);
  } catch (error) {
    if (keepOld) await makeLink(path.join(layout.releases, oldVersion), layout.current).catch(() => undefined);
    throw error;
  }

  // Drop releases that are neither current nor previous. A folder that is in use stays; that is not an error.
  const keep = new Set<string>([version]);
  const previousVersion = await releaseVersion(layout.previous);
  if (previousVersion !== undefined) keep.add(previousVersion);
  for (const name of await readdir(layout.releases).catch(() => [] as string[])) {
    if (!keep.has(name)) await rm(path.join(layout.releases, name), { recursive: true, force: true }).catch(() => undefined);
  }
  return { version, ...(previousVersion === undefined ? {} : { previousVersion }) };
}

/** Swaps `current` and `current.previous`. */
export async function rollbackJunctionRelease(layout: InstallLayout): Promise<{ version: string; previousVersion?: string }> {
  const previousVersion = await releaseVersion(layout.previous);
  if (previousVersion === undefined) throw new Error("previous_release_missing");
  const currentVersion = await releaseVersion(layout.current);
  const previousDirectory = path.join(layout.releases, previousVersion);
  if (!(await exists(previousDirectory))) throw new Error("previous_release_missing");
  await removeLink(layout.current);
  await makeLink(previousDirectory, layout.current);
  await removeLink(layout.previous);
  if (currentVersion !== undefined && (await exists(path.join(layout.releases, currentVersion)))) {
    await makeLink(path.join(layout.releases, currentVersion), layout.previous);
  }
  return { version: previousVersion, ...(currentVersion === undefined ? {} : { previousVersion: currentVersion }) };
}
