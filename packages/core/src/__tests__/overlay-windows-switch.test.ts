import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOsseoConfig } from "../index.js";

describe("overlay.windows switch", () => {
  it("is off by default", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "osseo-windows-switch-default-"));
    const config = await loadOsseoConfig({ env: {}, homeDir });
    expect(config.overlay?.windows).toBe(false);
  });

  it("reads true from config.json, so no environment variable is needed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-windows-switch-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, overlay: { windows: true } }));
    const config = await loadOsseoConfig({ env: {}, homeDir: dir, configPath });
    expect(config.overlay?.windows).toBe(true);
  });
});
