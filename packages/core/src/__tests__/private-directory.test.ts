import { describe, expect, it } from "vitest";
import { mkdtemp, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDirectory } from "../private-directory.js";

describe("ensurePrivateDirectory", () => {
  // Windows has no POSIX mode bits, so the mode check runs only where they exist.
  it.skipIf(process.platform === "win32")("creates an owner-only directory on POSIX", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "osseo-private-"));
    try {
      const directory = path.join(root, "home", ".osseo");
      const result = await ensurePrivateDirectory(directory, { platform: "linux" });
      expect(result).toEqual({ ok: true, method: "posix_mode" });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sets an access list on Windows: inheritance off, only the user and SYSTEM kept", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "osseo-private-win-"));
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const directory = path.join(root, ".osseo");
      const result = await ensurePrivateDirectory(directory, {
        platform: "win32",
        user: "DESKTOP-1\\alice",
        run: async (command, args) => { calls.push({ command, args }); }
      });
      expect(result).toEqual({ ok: true, method: "icacls" });
      expect(calls).toEqual([{
        command: "icacls",
        args: [directory, "/inheritance:r", "/grant:r", "DESKTOP-1\\alice:(OI)(CI)F", "/grant:r", "SYSTEM:(OI)(CI)F"]
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a failed icacls run instead of claiming the folder is private", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "osseo-private-fail-"));
    try {
      const result = await ensurePrivateDirectory(path.join(root, "x"), {
        platform: "win32",
        user: "alice",
        run: async () => { throw new Error("Access is denied."); }
      });
      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected a failure");
      expect(result.reason).toContain("Access is denied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
