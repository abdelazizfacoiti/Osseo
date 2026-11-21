import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

// Runs the built stdio server headless (no display, no cards), so `npm run build` must come first.
const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

async function connect(home: string, answer: "approve" | "decline" | "none") {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "DISPLAY" && key !== "WAYLAND_DISPLAY") env[key] = value;
  env.OSSEO_HOME = home;
  env.NODE_ENV = "test";
  const client = new Client({ name: "chat-approval-e2e", version: "1" }, { capabilities: answer === "none" ? {} : { elicitation: {} } });
  const prompts: string[] = [];
  if (answer !== "none") {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts.push(request.params.message);
      return answer === "approve" ? { action: "accept", content: { approve: true } } : { action: "decline" };
    });
  }
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
  return { client, prompts };
}

function textOf(result: unknown): string {
  return JSON.stringify(result);
}

describe("approval in chat (built server, headless)", () => {
  it("asks through elicitation, then the exact retry runs; a decline blocks it", async () => {
    expect(existsSync(SERVER), "Build first: npm run build").toBe(true);
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-chat-e2e-"));
    const work = mkdtempSync(path.join(os.tmpdir(), "osseo-chat-e2e-files-"));
    try {
      const target = path.join(work, "report.txt");
      writeFileSync(target, "x");
      const approve = await connect(home, "approve");
      try {
        const first = await approve.client.callTool({ name: "file.delete", arguments: { path: target, dryRun: false } });
        const text = textOf(first);
        expect(approve.prompts.length).toBe(1);
        expect(approve.prompts[0]).toContain("file.delete");
        expect(text).toContain("approved this in chat");
        const token = /confirmationToken (\S+?)[."\\]/.exec(text)?.[1];
        expect(token).toBeDefined();
        const retry = await approve.client.callTool({ name: "file.delete", arguments: { path: target, dryRun: false, confirmationToken: token } });
        expect(textOf(retry)).not.toContain("confirmation_required");
        expect(existsSync(target)).toBe(false);
      } finally {
        await approve.client.close();
      }
      writeFileSync(target, "x");
      const decline = await connect(home, "decline");
      try {
        const first = await decline.client.callTool({ name: "file.delete", arguments: { path: target, dryRun: false } });
        expect(textOf(first)).toContain("denied this action in chat");
        expect(existsSync(target)).toBe(true);
      } finally {
        await decline.client.close();
      }
      const quiet = await connect(home, "none");
      try {
        const first = await quiet.client.callTool({ name: "file.delete", arguments: { path: target, dryRun: false } });
        expect(textOf(first)).toContain("confirmation_required");
        expect(textOf(first)).not.toContain("in chat");
      } finally {
        await quiet.client.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
