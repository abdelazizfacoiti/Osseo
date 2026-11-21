import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findChromeExecutable } from "@osseo/os-linux";
import { describe, expect, it } from "vitest";

// Runs the built stdio server headless (no display), so `npm run build` must come first.
const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

const FORM = `<!doctype html><html><head><title>Numbers form</title></head><body>
<label for="name">Name</label><input id="name" type="text" value="">
<label for="pw">Password</label><input id="pw" type="password">
<button id="go" type="button" onclick="document.getElementById('echo').value = document.getElementById('name').value + ' saved'">Save</button>
<label for="echo">Echo</label><input id="echo" type="text" value="">
</body></html>`;

async function connect(home: string) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "DISPLAY" && key !== "WAYLAND_DISPLAY" && key !== "OSSEO_TOOLS_PROFILE") env[key] = value;
  env.OSSEO_HOME = home;
  env.NODE_ENV = "test";
  const client = new Client({ name: "see-e2e", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
  return client;
}

function parse(result: unknown): any {
  const text = ((result as { content: Array<{ type: string; text?: string }> }).content.find((item) => item.type === "text")?.text) ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function dataOf(result: unknown): any {
  const body = parse(result);
  return body.data ?? body;
}

describe("see and numbered actions (built server, headless)", () => {
  it("lists exactly the fourteen default tools", async () => {
    expect(existsSync(SERVER), "Build first: npm run build").toBe(true);
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-see-e2e-"));
    const client = await connect(home);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["ask", "click", "drag", "guide.clear", "guide.show", "key", "open", "scroll", "see", "status", "steps", "type", "wait", "windows"]);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  const chrome = findChromeExecutable();
  it.skipIf(chrome === undefined)("opens a form, types by number, clicks by number and sees the new value", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-see-e2e-"));
    const work = mkdtempSync(path.join(os.tmpdir(), "osseo-see-e2e-page-"));
    const client = await connect(home);
    try {
      const file = path.join(work, "form.html");
      writeFileSync(file, FORM);
      const opened = await client.callTool({ name: "open", arguments: { url: pathToFileURL(file).href } });
      expect(opened.isError, JSON.stringify(opened)).toBeFalsy();

      const first = dataOf(await client.callTool({ name: "see", arguments: { picture: "none" } }));
      expect(first.source).toBe("dom");
      const lines: string[] = first.list.split("\n");
      const find = (needle: string) => Number(/^\[(\d+)\]/.exec(lines.find((line) => line.includes(needle))!)![1]);
      const nameN = find('"Name"');
      const saveN = find('"Save"');
      expect(lines.join("\n")).toMatch(/password field.*\(blocked\)|entry.*\(blocked\)/);

      const typed = await client.callTool({ name: "type", arguments: { n: nameN, text: "Ada" } });
      expect(typed.isError, JSON.stringify(typed)).toBeFalsy();
      expect(JSON.stringify(typed)).toContain("Call see again");
      const clicked = await client.callTool({ name: "click", arguments: { n: saveN } });
      expect(clicked.isError, JSON.stringify(clicked)).toBeFalsy();

      const after = dataOf(await client.callTool({ name: "see", arguments: { picture: "none" } }));
      expect(after.list).toContain('= "Ada"');
      expect(after.list).toContain('= "Ada saved"');

      // The blocked password field cannot be typed into by number.
      const pw = Number(/^\[(\d+)\]/.exec((after.list as string).split("\n").find((line) => line.includes("(blocked)"))!)![1]);
      const refused = await client.callTool({ name: "type", arguments: { n: pw, text: "x" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("target_blocked");
    } finally {
      await client.callTool({ name: "status", arguments: {} }).catch(() => undefined);
      await client.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);
});
