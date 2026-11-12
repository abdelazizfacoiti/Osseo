import { describe, expect, it } from "vitest";
import { createWindowsDesktop } from "@agenthost/os-windows";
import type { AgentHostMcpContext } from "../context.js";
import { resolveLabelTarget } from "../label-target.js";
import { outlineOf } from "../tools/screen.js";

/**
 * The Windows accessibility adapter feeding the tools that were written against AT-SPI: label clicks,
 * the screen outline, and the field read-back, with a fake helper standing in for UI Automation.
 */

const FORM = { hwnd: "1001", title: "AgentHost Check Window", pid: 10, process: "powershell", x: 200, y: 200, width: 400, height: 140, minimized: false };
const SAVE = { x: 220, y: 270, width: 120, height: 40 };
const BOX = { x: 220, y: 220, width: 360, height: 24 };

function helper(requests: Array<{ method: string; params: Record<string, unknown> }> = []): any {
  return {
    async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      requests.push({ method, params });
      switch (method) {
        case "windows.list": return { windows: [FORM], truncated: false };
        case "uia.tree": return {
          root: { id: "1001:#a", role: "window", name: FORM.title, enabled: true, children: [
            { id: "1001:0#b", role: "entry", name: "Name", bounds: BOX, enabled: true },
            { id: "1001:1#c", role: "password text", name: "Secret", bounds: { x: 220, y: 250, width: 360, height: 20 }, enabled: true, sensitive: true },
            { id: "1001:2#d", role: "push button", name: "Save", bounds: SAVE, enabled: true }
          ] },
          nodeCount: 4, truncated: false, redacted: true
        };
        case "uia.find": {
          const query = String(params.query).toLowerCase();
          const all = [
            { id: "1001:2#d", role: "push button", name: "Save", bounds: SAVE, confidence: 1, reason: "Matched accessibility query.", enabled: true },
            { id: "1001:3#e", role: "push button", name: "Save as", bounds: { x: 350, y: 270, width: 120, height: 40 }, confidence: 0.9, reason: "Matched accessibility query.", enabled: false }
          ];
          return { candidates: all.filter((item) => item.name.toLowerCase().includes(query)), truncated: false };
        }
        case "uia.textAtPoint": return { found: true, role: "entry", focused: true, sensitive: false, text: "hello", length: 5 };
        default: throw new Error(`unexpected ${method}`);
      }
    },
    close() {}
  };
}

function contextOf() {
  const desktop = createWindowsDesktop(helper());
  return { linux: desktop } as unknown as AgentHostMcpContext;
}

describe("Windows accessibility through the shared tools", () => {
  it("resolves a button label to the centre of its UI Automation bounds", async () => {
    const result = await resolveLabelTarget(contextOf(), { windowId: "1001", appName: "powershell", pid: 10 }, { label: "Save", role: "push button" }, { ocr: false });
    expect(result).toMatchObject({ ok: true, target: { point: { x: 280, y: 290 }, source: "accessibility", name: "Save", role: "push button", enabled: true } });
  });

  it("refuses a disabled control by label, as it does on Linux", async () => {
    const result = await resolveLabelTarget(contextOf(), { windowId: "1001", pid: 10 }, { label: "Save as" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "control_disabled" });
  });

  it("outlines the active window without the password field or its name", async () => {
    const tree = await createWindowsDesktop(helper()).getAccessibilityTree({ pid: 10, maxDepth: 14, maxNodes: 600, includeText: false });
    const outline = outlineOf(tree.root as never, 2048);
    expect(outline.lines).toEqual([
      "window \"AgentHost Check Window\"",
      "  entry \"Name\" @220,220 360x24",
      "  push button \"Save\" @220,270 120x40"
    ]);
    expect(outline.lines.join("\n")).not.toContain("Secret");
  });

  it("offers the field read-back set_field needs, scoped by the window's pid", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const desktop = createWindowsDesktop(helper(requests));
    const read = await desktop.readTextAtPoint({ pid: 10, x: 300, y: 230 });
    expect(read).toMatchObject({ supported: true, found: true, focused: true, sensitive: false, text: "hello" });
    expect(requests.find((r) => r.method === "uia.textAtPoint")?.params).toMatchObject({ x: 300, y: 230, pid: 10 });
  });
});
