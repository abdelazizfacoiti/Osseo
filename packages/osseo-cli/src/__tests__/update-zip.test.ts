import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLayout } from "../install-layout.js";
import { releaseVersion, rollbackJunctionRelease } from "../junction-release.js";
import { updateFromZip } from "../update-zip.js";
import { writeZip, type ZipEntry } from "../zip.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temp(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-upd-")); roots.push(dir); return dir; }

/** A layout on a real temporary folder; the platform label selects the junction code path. */
async function fakeLayout(): Promise<{ layout: InstallLayout; tmp: string }> {
  const root = await temp();
  const tmp = await temp();
  return { tmp, layout: { platform: "win32", root, releases: path.join(root, "releases"), current: path.join(root, "current"), previous: path.join(root, "current.previous"), bin: path.join(root, "bin"), launchers: [] } };
}

function release(version: string, extra: Partial<Record<string, unknown>> = {}, omit: string[] = []): ZipEntry[] {
  const top = `osseo-v${version}-win-x64`;
  const manifest = { product: "Osseo", version, platform: "windows", architecture: "x64", ...extra };
  const files: Record<string, string> = {
    "version.json": JSON.stringify(manifest),
    "bin/osseo.mjs": "// entry\n",
    "packages/mcp-server/dist/index.js": `// ${version}\n`
  };
  return Object.entries(files).filter(([name]) => !omit.includes(name)).map(([name, data]) => ({ name: `${top}/${name}`, data: Buffer.from(data) }));
}

async function archive(entries: ZipEntry[]): Promise<{ file: string; checksum: string }> {
  const dir = await temp();
  const file = path.join(dir, "release.zip");
  const zip = writeZip(entries);
  await writeFile(file, zip);
  return { file, checksum: createHash("sha256").update(zip).digest("hex") };
}

describe("updating from a Windows zip", () => {
  it("previews without touching the install", async () => {
    const { layout, tmp } = await fakeLayout();
    const a = await archive(release("1.2.3"));
    const result = await updateFromZip({ archive: a.file, checksum: a.checksum, apply: false, layout, tmpDir: tmp });
    expect(result).toMatchObject({ ok: true, data: { preview: true, version: "1.2.3", checksumVerified: true } });
    expect(existsSync(layout.root + "/releases")).toBe(false);
  });

  it("installs, upgrades, keeps the previous release and rolls back", async () => {
    const { layout, tmp } = await fakeLayout();
    const one = await archive(release("1.0.0"));
    expect(await updateFromZip({ archive: one.file, checksum: one.checksum, apply: true, layout, tmpDir: tmp })).toMatchObject({ ok: true, data: { applied: true, version: "1.0.0", rollbackAvailable: false } });
    expect((await lstat(layout.current)).isSymbolicLink()).toBe(true);
    expect(await releaseVersion(layout.current)).toBe("1.0.0");
    expect(await readFile(path.join(layout.current, "bin", "osseo.mjs"), "utf8")).toBe("// entry\n");

    const two = await archive(release("1.1.0"));
    expect(await updateFromZip({ archive: two.file, checksum: two.checksum, apply: true, layout, tmpDir: tmp })).toMatchObject({ ok: true, data: { version: "1.1.0", rollbackAvailable: true } });
    expect(await releaseVersion(layout.current)).toBe("1.1.0");
    expect(await releaseVersion(layout.previous)).toBe("1.0.0");

    const three = await archive(release("1.2.0"));
    await updateFromZip({ archive: three.file, checksum: three.checksum, apply: true, layout, tmpDir: tmp });
    expect(await readdir(layout.releases)).toEqual(["1.1.0", "1.2.0"]);

    expect(await rollbackJunctionRelease(layout)).toEqual({ version: "1.1.0", previousVersion: "1.2.0" });
    expect(await releaseVersion(layout.current)).toBe("1.1.0");
    expect(await releaseVersion(layout.previous)).toBe("1.2.0");
    expect(await readdir(tmp)).toEqual([]);
  });

  it("installing the same version again works and keeps one release", async () => {
    const { layout, tmp } = await fakeLayout();
    const a = await archive(release("1.0.0"));
    await updateFromZip({ archive: a.file, checksum: a.checksum, apply: true, layout, tmpDir: tmp });
    expect(await updateFromZip({ archive: a.file, checksum: a.checksum, apply: true, layout, tmpDir: tmp })).toMatchObject({ ok: true, data: { version: "1.0.0" } });
    expect(await releaseVersion(layout.current)).toBe("1.0.0");
    expect(await readdir(layout.releases)).toEqual(["1.0.0"]);
  });

  it("refuses a wrong platform, a missing entry file, a version mismatch and a bad layout", async () => {
    const { layout, tmp } = await fakeLayout();
    const run = async (entries: ZipEntry[]) => { const a = await archive(entries); return await updateFromZip({ archive: a.file, checksum: a.checksum, apply: true, layout, tmpDir: tmp }); };
    expect(await run(release("1.0.0", { platform: "linux" }))).toEqual({ ok: false, error: "release_platform_mismatch" });
    expect(await run(release("1.0.0", {}, ["bin/osseo.mjs"]))).toEqual({ ok: false, error: "archive_health_check_failed" });
    expect(await run(release("1.0.0", { version: "9.9.9" }))).toEqual({ ok: false, error: "release_version_mismatch" });
    expect(await run([...release("1.0.0"), { name: "other/file", data: Buffer.from("x") }])).toEqual({ ok: false, error: "archive_layout_invalid" });
    expect(await run([{ name: "osseo-v1.0.0-linux-x64/version.json", data: Buffer.from("{}") }])).toEqual({ ok: false, error: "release_version_invalid" });
    expect(existsSync(layout.current)).toBe(false);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("refuses zip files on a non-Windows layout and unreadable zips", async () => {
    const { layout, tmp } = await fakeLayout();
    const a = await archive(release("1.0.0"));
    expect(await updateFromZip({ archive: a.file, checksum: a.checksum, apply: true, layout: { ...layout, platform: "linux" }, tmpDir: tmp })).toEqual({ ok: false, error: "zip_archive_windows_only" });
    const dir = await temp();
    await writeFile(path.join(dir, "bad.zip"), "nope");
    const bad = await updateFromZip({ archive: path.join(dir, "bad.zip"), checksum: "0", apply: true, layout, tmpDir: tmp });
    expect(bad).toEqual({ ok: false, error: "archive_invalid:zip_invalid" });
  });

  it("moves an older plain `current` folder aside", async () => {
    const { layout, tmp } = await fakeLayout();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(layout.current, { recursive: true });
    await writeFile(path.join(layout.current, "version.json"), JSON.stringify({ version: "0.9.0" }));
    const a = await archive(release("1.0.0"));
    await updateFromZip({ archive: a.file, checksum: a.checksum, apply: true, layout, tmpDir: tmp });
    expect(await releaseVersion(layout.previous)).toBe("0.9.0");
    expect(await releaseVersion(layout.current)).toBe("1.0.0");
  });
});
