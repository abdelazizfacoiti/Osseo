import { describe, expect, it } from "vitest";
import { createDesktopTools, readbackVerdict } from "../tools/desktop.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";

describe("readbackVerdict", () => {
  it("is unknown when there is no expected text to compare", () => {
    expect(readbackVerdict(undefined, [{ readable: true, text: "anything" }])).toEqual({ confirmed: "unknown" });
  });

  it("is unknown when the field could not be read at all", () => {
    expect(readbackVerdict("hello", [{ readable: false }])).toEqual({ confirmed: "unknown" });
    expect(readbackVerdict("hello", [])).toEqual({ confirmed: "unknown" });
  });

  it("confirms an exact match and reports the observed length", () => {
    expect(readbackVerdict("hello", [{ readable: true, text: "hello" }])).toEqual({ confirmed: true, observedLength: 5 });
  });

  it("keeps sampling until the field settles on the expected text", () => {
    const samples = [{ readable: true, text: "hel" }, { readable: true, text: "hello" }];
    expect(readbackVerdict("hello", samples)).toEqual({ confirmed: true, observedLength: 5 });
  });

  it("reports a mismatch when every sample differs", () => {
    const samples = [{ readable: true, text: "hell" }, { readable: true, text: "hellx" }];
    expect(readbackVerdict("hello", samples)).toEqual({ confirmed: false, observedLength: 5 });
  });

  it("counts an empty field as a readable empty string, not as unknown", () => {
    expect(readbackVerdict("", [{ readable: true, text: "" }])).toEqual({ confirmed: true, observedLength: 0 });
    expect(readbackVerdict("x", [{ readable: true, text: "" }])).toEqual({ confirmed: false, observedLength: 0 });
  });
});

describe("desktop.set_field input rules", () => {
  const tool = createDesktopTools().find((item) => item.name === "desktop.set_field");
  const parse = (input: unknown) => tool!.inputSchema.safeParse(input);

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("needs text (empty is allowed, to clear)", () => {
    expect(parse({ x: 1, y: 2, activeWindow: { appName: "Gedit" } }).success).toBe(false);
    expect(parse({ x: 1, y: 2, text: "", activeWindow: { appName: "Gedit" } }).success).toBe(true);
  });

  it("takes x and y, or a label, never both and never neither", () => {
    expect(parse({ x: 1, y: 2, label: "Name", text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(false);
    expect(parse({ text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(false);
    expect(parse({ x: 1, text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(false);
    expect(parse({ label: "Name", text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(true);
    expect(parse({ x: 1, y: 2, text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(true);
  });

  it("refuses a role without a label", () => {
    expect(parse({ role: "entry", x: 1, y: 2, text: "a", activeWindow: { appName: "Gedit" } }).success).toBe(false);
  });

  it("is declared as a state-changing tool in the production metadata", () => {
    const [classified] = applyProductionExecutionMetadata([tool!]);
    expect(classified?.execution?.executionClass).toBe("state_changing");
  });
});
