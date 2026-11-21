#!/usr/bin/env node
// Builds the Windows release zip from the Linux release stage. Node only: no zip binary.
//   npm run build && npm run release:build && npm run release:build:windows
// Output in release/: osseo-v<version>-win-x64.zip (+ .sha256) and the fixed-name copy
// osseo-win-x64.zip (+ .sha256) that scripts/install.ps1 downloads from the latest release.
// release/SHA256SUMS is not touched: it belongs to the Linux archive that verify-release checks.
import { cp, copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectReleaseFiles, validateReleaseTree } from "./release-integrity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = rootPackage.version;
const releaseRoot = path.join(root, "release");
const linuxStage = path.join(releaseRoot, `osseo-v${version}-linux-x64`);
const manifestPath = path.join(linuxStage, "version.json");
if (!(await stat(manifestPath).catch(() => undefined))) throw new Error("release_stage_missing: run npm run release:build first");
const zipModule = path.join(root, "packages", "osseo-cli", "dist", "zip.js");
if (!(await stat(zipModule).catch(() => undefined))) throw new Error("build_missing: run npm run build first");
const { writeZip, listZip, readZipEntry } = await import(pathToFileURL(zipModule).href);

const linuxManifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (linuxManifest.version !== version) throw new Error("release_stage_version_mismatch");

const top = `osseo-v${version}-win-x64`;
const work = await mkdtemp(path.join(os.tmpdir(), "osseo-winrel-"));
try {
  const stage = path.join(work, top);
  // Left out: Linux-only files (the GTK overlay runtime, the apt package list), .bin shims (symlinks), the manifest (rewritten below).
  const skip = new Set(["version.json", "requirements-linux.txt", "packages/app-overlay/runtime", "packages/os-linux/runtime", "node_modules/@osseo/app-overlay/runtime", "node_modules/@osseo/os-linux/runtime", "node_modules/.bin"]);
  await cp(linuxStage, stage, {
    recursive: true,
    dereference: true,
    filter: (source) => !skip.has(path.relative(linuxStage, source).split(path.sep).join("/"))
  });
  // Nothing that runs only on Linux, and no native code.
  const native = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(item);
      else if (/\.(node|exe|dll|so|dylib|py)$/iu.test(entry.name)) native.push(path.relative(stage, item).split(path.sep).join("/"));
    }
  }
  await walk(stage);
  if (native.length > 0) throw new Error(`windows_release_native_files:${native.slice(0, 5).join(",")}`);

  const inventory = await collectReleaseFiles(stage);
  if (inventory.symlinkFailures.length > 0) throw new Error(`release_symlink_invalid:${inventory.symlinkFailures.join(",")}`);
  const manifest = {
    ...linuxManifest,
    platform: "windows",
    architecture: "x64",
    requires: { node: ">=20" },
    limitations: [
      "Checked on Windows 11 Pro (desktop helper, headless tools, browser, overlay guard and dock) only. Other Windows versions are not checked.",
      "The visible overlay is opt-in (overlay.windows or OSSEO_WINDOWS_OVERLAY=1). The rail layout is not drawn on Windows.",
      "The release is built from the platform-neutral stage (npm run release:build -- --stage-only); the Linux tarball is still built on Linux."
    ],
    files: inventory.files
  };
  await writeFile(path.join(stage, "version.json"), JSON.stringify(manifest, null, 2) + "\n");
  const failures = await validateReleaseTree(stage, manifest, { platform: "windows" });
  if (failures.length > 0) throw new Error(`release_tree_invalid:${failures.join(",")}`);

  const entries = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) { await collect(item); continue; }
      const relative = path.relative(stage, item).split(path.sep).join("/");
      entries.push({ name: `${top}/${relative}`, data: await readFile(item), mode: relative === "bin/osseo.mjs" ? 0o755 : 0o644 });
    }
  }
  await collect(stage);
  const zip = writeZip(entries);
  const archive = path.join(releaseRoot, `${top}.zip`);
  await writeFile(archive, zip);
  // Read it back the way the updater will.
  const listing = listZip(zip);
  for (const entry of listing) readZipEntry(zip, entry);
  if (listing.length !== entries.length) throw new Error("windows_zip_entry_count");
  const hash = createHash("sha256").update(zip).digest("hex");
  await writeFile(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  const latest = path.join(releaseRoot, "osseo-win-x64.zip");
  await copyFile(archive, latest);
  await writeFile(`${latest}.sha256`, `${hash}  ${path.basename(latest)}\n`);
  console.log(JSON.stringify({ archive, version, fileCount: entries.length, sha256: hash }, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
