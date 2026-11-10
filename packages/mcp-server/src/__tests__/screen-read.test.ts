import { describe, expect, it } from "vitest";
import { outlineOf } from "../tools/screen.js";

const tree = {
  role: "frame",
  name: "Mail",
  children: [
    { role: "panel", children: [
      { role: "push button", name: "Send", enabled: true, bounds: { x: 10, y: 20, width: 80, height: 30 } },
      { role: "push button", name: "Discard", enabled: false, bounds: { x: 100, y: 20, width: 80, height: 30 } }
    ] },
    { role: "text", name: "To", enabled: true, bounds: { x: 10, y: 60, width: 300, height: 24 } },
    { role: "password text", name: "Password", sensitive: true, bounds: { x: 10, y: 90, width: 300, height: 24 } },
    { role: "label", name: "Hidden label", hidden: true },
    { role: "panel", children: [] }
  ]
};

describe("outlineOf", () => {
  it("lists named and actionable elements with state and bounds", () => {
    const outline = outlineOf(tree, 2048);
    expect(outline.lines).toEqual([
      "frame \"Mail\"",
      "  push button \"Send\" @10,20 80x30",
      "  push button \"Discard\" [disabled] @100,20 80x30",
      "  text \"To\" @10,60 300x24"
    ]);
    expect(outline.truncated).toBe(false);
  });

  it("never shows hidden or sensitive elements, not even their names", () => {
    const text = outlineOf(tree, 2048).lines.join("\n");
    expect(text).not.toContain("Password");
    expect(text).not.toContain("Hidden label");
  });

  it("stops at the byte cap and says so", () => {
    const outline = outlineOf(tree, 60);
    expect(outline.truncated).toBe(true);
    expect(outline.lines.join("\n").length).toBeLessThanOrEqual(60);
  });

  it("returns nothing for an empty tree", () => {
    expect(outlineOf(undefined, 2048)).toEqual({ lines: [], elements: 0, truncated: false });
  });

  it("cuts long names to keep lines short", () => {
    const long = { role: "link", name: "x".repeat(200) };
    const [line] = outlineOf(long, 2048).lines;
    expect(line!.length).toBeLessThan(90);
    expect(line!.endsWith("…\"")).toBe(true);
  });
});
