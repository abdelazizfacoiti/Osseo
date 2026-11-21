import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyLegacyEnv, classifyShellCommand, defaultOsseoHome, defaultPublicConfigPath, getDefaultPolicy, loadOsseoConfig } from "../index.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "osseo-legacy-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("installs from before the rename", () => {
  it("reads AGENTHOST_* as OSSEO_* unless the new variable is set", () => {
    const env: Record<string, string | undefined> = { AGENTHOST_HOME: "/old", AGENTHOST_TOOLS_PROFILE: "full", OSSEO_TOOLS_PROFILE: "desktop" };
    applyLegacyEnv(env);
    expect(env.OSSEO_HOME).toBe("/old");
    expect(env.OSSEO_TOOLS_PROFILE).toBe("desktop");
  });

  it("keeps using ~/.agenthost until ~/.osseo exists", () => {
    const home = tmp();
    expect(defaultOsseoHome(home)).toBe(path.join(home, ".osseo"));
    mkdirSync(path.join(home, ".agenthost"));
    expect(defaultOsseoHome(home)).toBe(path.join(home, ".agenthost"));
    mkdirSync(path.join(home, ".osseo"));
    expect(defaultOsseoHome(home)).toBe(path.join(home, ".osseo"));
  });

  it("finds ~/.config/agenthost/config.json until the new config folder exists", () => {
    const home = tmp();
    mkdirSync(path.join(home, ".config", "agenthost"), { recursive: true });
    require("node:fs").writeFileSync(path.join(home, ".config", "agenthost", "config.json"), "{}");
    expect(defaultPublicConfigPath(home, { platform: "linux" })).toBe(path.join(home, ".config", "agenthost", "config.json"));
  });

  it("still accepts the old agentHostDir key in a config file", async () => {
    const home = tmp();
    const dataDir = path.join(home, "data");
    const configPath = path.join(home, "config.json");
    require("node:fs").writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, agentHostDir: dataDir }));
    const config = await loadOsseoConfig({ homeDir: home, configPath, env: {} });
    expect(config.osseoDir).toBe(dataDir);
  });

  it("still blocks agent shell commands that touch the old control folder", () => {
    for (const folder of [".agenthost", ".osseo"]) {
      const policy = getDefaultPolicy();
      expect(classifyShellCommand(`touch ~/${folder}/run/stop.requested`, policy, { homeDir: "/home/tester" }).blocked).toBe(true);
      expect(classifyShellCommand(`echo x >> ~/${folder}/policy.toml`, policy, { homeDir: "/home/tester" }).blocked).toBe(true);
    }
  });
});
