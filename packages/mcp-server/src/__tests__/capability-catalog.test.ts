import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBaseCapabilityRegistry, loadOsseoConfig } from "@osseo/core";
import { describe, expect, it } from "vitest";
import { createOsseoMcpServer } from "../server.js";

describe("capability catalog", () => {
  it("lists exactly the tools the server registers, and no removed grant or Forge tools", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-catalog-"));
    const env: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, OSSEO_OVERLAY_MODE: "disabled", OSSEO_CONFIG: path.join(home, "none.json"), OSSEO_TOOLS_PROFILE: "full" };
    const config = await loadOsseoConfig({ env, homeDir: home });
    expect(createBaseCapabilityRegistry().listTools()).toEqual([]);
    const server = await createOsseoMcpServer({ config });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-test", version: "1" }, { capabilities: {} });
    await Promise.all([server.server.connect(a), client.connect(b)]);
    try {
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      const registered = server.context.registry.listTools().map((tool) => tool.name).sort();
      expect(registered).toEqual(listed);
      expect(registered.filter((name) => name.startsWith("forge.") || name === "policy.list_grants" || name === "policy.explain_decision")).toEqual([]);
    } finally {
      await client.close();
      await server.closeResources();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
