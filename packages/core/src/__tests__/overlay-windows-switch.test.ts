import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentHostConfig } from "../index.js";

describe("overlay.windows switch", () => {
  it("is off by default", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "agenthost-windows-switch-default-"));
    const config = await loadAgentHostConfig({ env: {}, homeDir });
    expect(config.overlay?.windows).toBe(false);
  });

  it("reads true from config.json, so no environment variable is needed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-windows-switch-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, overlay: { windows: true } }));
    const config = await loadAgentHostConfig({ env: {}, homeDir: dir, configPath });
    expect(config.overlay?.windows).toBe(true);
  });
});
