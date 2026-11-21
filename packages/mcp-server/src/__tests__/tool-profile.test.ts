import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadOsseoConfig } from "@osseo/core";
import { describe, expect, it } from "vitest";
import { createOsseoMcpServer } from "../server.js";
import { DEFAULT_TOOL_NAMES, hiddenToolHint, listedTools } from "../tool-profile.js";
import { readResource } from "../resources.js";

const FOURTEEN = ["see", "click", "type", "key", "scroll", "drag", "open", "windows", "wait", "ask", "steps", "status", "guide.show", "guide.clear"];

async function withServer(profile: string | undefined, run: (client: Client, home: string, server: Awaited<ReturnType<typeof createOsseoMcpServer>>) => Promise<void>) {
  const home = mkdtempSync(path.join(os.tmpdir(), "osseo-profile-"));
  const env: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, OSSEO_OVERLAY_MODE: "disabled", OSSEO_CONFIG: path.join(home, "none.json") };
  delete env.OSSEO_TOOLS_PROFILE;
  if (profile !== undefined) env.OSSEO_TOOLS_PROFILE = profile;
  const config = await loadOsseoConfig({ env, homeDir: home });
  const server = await createOsseoMcpServer({ config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "profile-test", version: "1" }, { capabilities: {} });
  await Promise.all([server.server.connect(a), client.connect(b)]);
  try {
    await run(client, home, server);
  } finally {
    await client.close();
    await server.closeResources();
    rmSync(home, { recursive: true, force: true });
  }
}

describe("config", () => {
  it("defaults to the desktop profile, reads the env override and rejects other values", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-profile-cfg-"));
    try {
      const base: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: path.join(home, "none.json") };
      delete base.OSSEO_TOOLS_PROFILE;
      expect((await loadOsseoConfig({ env: base, homeDir: home })).tools?.profile).toBe("desktop");
      expect((await loadOsseoConfig({ env: { ...base, OSSEO_TOOLS_PROFILE: "full" }, homeDir: home })).tools?.profile).toBe("full");
      await expect(loadOsseoConfig({ env: { ...base, OSSEO_TOOLS_PROFILE: "huge" }, homeDir: home })).rejects.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("tool profiles", () => {
  it("names exactly the fourteen default tools", () => {
    expect([...DEFAULT_TOOL_NAMES].sort()).toEqual([...FOURTEEN].sort());
    expect(listedTools([{ name: "see" }, { name: "file.read" }], "desktop")).toEqual([{ name: "see" }]);
    expect(listedTools([{ name: "see" }, { name: "file.read" }], "full")).toHaveLength(2);
  });

  it("desktop lists exactly the fourteen", async () => {
    await withServer(undefined, async (client) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(listed).toEqual([...FOURTEEN].sort());
    });
  });

  it("full lists the fourteen plus every existing tool", async () => {
    await withServer("full", async (client, _home, server) => {
      const listed = (await client.listTools()).tools.map((tool) => tool.name);
      expect(listed.length).toBe(server.context.tools!.size);
      for (const name of [...FOURTEEN, "file.read", "desktop.click", "browser.snapshot", "computer.run_steps", "shell.run", "screen.read"]) expect(listed).toContain(name);
      expect(listed.length).toBeGreaterThan(70);
    });
  });

  it("a hidden tool still works in the desktop profile and names the tool to use", async () => {
    await withServer(undefined, async (client) => {
      const hidden = await client.callTool({ name: "system.get_info", arguments: {} });
      expect(hidden.isError).toBeFalsy();
      expect(JSON.stringify(hidden)).toContain("system.get_info is outside the default tool list");
      const status = await client.callTool({ name: "status", arguments: {} });
      expect(JSON.stringify(status)).not.toContain("outside the default");
    });
  });

  it("hidden tools carry no hint in the full profile, and replacements are named", async () => {
    await withServer("full", async (client) => {
      expect(JSON.stringify(await client.callTool({ name: "system.get_info", arguments: {} }))).not.toContain("outside the default");
    });
    expect(hiddenToolHint("desktop.click")).toContain("prefer click");
    expect(hiddenToolHint("browser.snapshot")).toContain("prefer see");
  });

  it("an unknown name is still unknown", async () => {
    await withServer(undefined, async (client) => {
      expect(JSON.stringify(await client.callTool({ name: "nope.nothing", arguments: {} }))).toContain("unknown_tool");
    });
  });

  it("the capability resources follow the profile", async () => {
    await withServer(undefined, async (_client, _home, server) => {
      const json = JSON.parse((await readResource({ registry: server.context.registry, config: server.context.config }, "osseo://capabilities")).text);
      expect(json.toolCount).toBe(14);
      const markdown = (await readResource({ registry: server.context.registry, config: server.context.config }, "osseo://capabilities.md")).text;
      expect(markdown).toContain("profile desktop");
      expect(markdown).toContain("see");
    });
    await withServer("full", async (_client, _home, server) => {
      const json = JSON.parse((await readResource({ registry: server.context.registry, config: server.context.config }, "osseo://capabilities")).text);
      expect(json.toolCount).toBeGreaterThan(70);
    });
  });

  it("a numbered action refuses an unknown view without touching the screen", async () => {
    await withServer(undefined, async (client) => {
      const result = await client.callTool({ name: "click", arguments: { n: 1, view: "v_000000" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("view_unknown");
    });
  });
});
