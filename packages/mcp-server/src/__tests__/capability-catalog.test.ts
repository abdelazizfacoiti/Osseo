import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBaseCapabilityRegistry, loadAgentHostConfig } from "@agenthost/core";
import { describe, expect, it } from "vitest";
import { createAgentHostMcpServer } from "../server.js";

describe("capability catalog", () => {
  it("lists exactly the tools the server registers, and no removed grant or Forge tools", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-catalog-"));
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_OVERLAY_MODE: "disabled", AGENTHOST_CONFIG: path.join(home, "none.json"), AGENTHOST_TOOLS_PROFILE: "full" };
    const config = await loadAgentHostConfig({ env, homeDir: home });
    expect(createBaseCapabilityRegistry().listTools()).toEqual([]);
    const server = await createAgentHostMcpServer({ config });
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
