import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "install.sh");
const RELEASE_DIR = path.join(ROOT, "release");
const ARCHIVE = existsSync(RELEASE_DIR)
  ? readdirSync(RELEASE_DIR).filter((name) => /^osseo-v.*-linux-x64\.tar\.gz$/u.test(name)).map((name) => path.join(RELEASE_DIR, name))[0]
  : undefined;
const usable = ARCHIVE !== undefined && existsSync(`${ARCHIVE}.sha256`) && process.platform === "linux" && process.arch === "x64";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "osseo-install-test-"));
  dirs.push(dir);
  return dir;
}
function run(home: string, archive: string | undefined, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.OSSEO_ARCHIVE; delete env.OSSEO_ARCHIVE_URL;
  if (archive) env.OSSEO_ARCHIVE = archive;
  return spawnSync("sh", [SCRIPT, ...args], { env, encoding: "utf8" });
}

describe("scripts/install.sh", () => {
  it("passes sh -n", () => {
    expect(spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" }).status).toBe(0);
  });

  it("prints help and changes nothing", () => {
    const home = tempDir();
    const result = run(home, undefined, "--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--dry-run");
    expect(readdirSync(home)).toEqual([]);
  });

  describe.skipIf(!usable)("with the release archive", () => {
    it("dry run changes nothing", () => {
      const home = tempDir();
      const result = run(home, ARCHIVE, "--dry-run");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Dry run");
      expect(readdirSync(home)).toEqual([]);
    });

    // Unpacks the archive twice: slow when the whole suite runs in parallel.
    it("installs a working launcher and survives a second run", { timeout: 60_000 }, () => {
      const home = tempDir();
      const first = run(home, ARCHIVE);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout.trim().split("\n").length).toBeLessThanOrEqual(6);
      const launcher = path.join(home, ".local", "bin", "osseo");
      expect(existsSync(launcher)).toBe(true);
      expect(existsSync(path.join(home, ".local", "share", "osseo", "current", "version.json"))).toBe(true);
      const help = spawnSync(launcher, ["--help"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect(help.status).toBe(0);
      expect(`${help.stdout}${help.stderr}`).toContain("osseo");

      const second = run(home, ARCHIVE);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("already installed");
      expect(spawnSync(launcher, ["--help"], { env: { ...process.env, HOME: home }, encoding: "utf8" }).status).toBe(0);
    });

    it("stops on a wrong checksum and installs nothing", () => {
      const home = tempDir();
      const copy = path.join(tempDir(), "release.tar.gz");
      copyFileSync(ARCHIVE!, copy);
      writeFileSync(`${copy}.sha256`, `${"0".repeat(64)}  release.tar.gz\n`);
      const result = run(home, copy);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("mismatch");
      expect(readdirSync(home)).toEqual([]);
    });

    it("stops when the checksum file is missing", () => {
      const home = tempDir();
      const copy = path.join(tempDir(), "release.tar.gz");
      copyFileSync(ARCHIVE!, copy);
      const result = run(home, copy);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum file missing");
      expect(readdirSync(home)).toEqual([]);
    });
  });
});
