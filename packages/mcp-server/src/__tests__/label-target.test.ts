import { describe, expect, it, vi } from "vitest";
import type { AccessibilityElementCandidate, DesktopWindowBounds, DesktopWindowContext } from "@agenthost/core";
import type { AgentHostMcpContext } from "../context.js";
import { resolveLabelTarget } from "../label-target.js";

const WINDOW: DesktopWindowBounds = { x: 0, y: 0, width: 800, height: 600 };
const ACTIVE: DesktopWindowContext = { windowId: "w1", appName: "Firefox", pid: 4242 };

function candidate(name: string, bounds: DesktopWindowBounds, extra: Partial<AccessibilityElementCandidate> = {}): AccessibilityElementCandidate {
  return { id: `id-${name}-${bounds.x}-${bounds.y}`, role: "push button", name, bounds, confidence: 1, reason: "Matched accessibility query.", ...extra };
}

function fakeContext(options: {
  candidates?: AccessibilityElementCandidate[];
  supported?: boolean;
  reason?: string;
  windows?: DesktopWindowBounds;
  activeSupported?: boolean;
}) {
  const findAccessibilityElement = vi.fn(async (_input: Record<string, unknown>) => ({
    supported: options.supported ?? true,
    backend: "atspi",
    candidates: options.candidates ?? [],
    reason: options.reason ?? "Found accessibility element candidates through AT-SPI."
  }));
  const listWindows = vi.fn(async () => ({
    supported: true,
    backend: "fake",
    reason: "",
    windows: [{ windowId: "w1", bounds: options.windows ?? WINDOW }]
  }));
  const getActiveWindow = vi.fn(async () => ({ supported: options.activeSupported ?? false, backend: "fake", reason: "", activeWindow: undefined }));
  const context = { linux: { findAccessibilityElement, listWindows, getActiveWindow } } as unknown as AgentHostMcpContext;
  return { context, findAccessibilityElement };
}

describe("resolveLabelTarget (AT-SPI)", () => {
  it("clicks the centre of a single exact, enabled match inside the active window", async () => {
    const { context } = fakeContext({ candidates: [candidate("Send", { x: 100, y: 50, width: 80, height: 20 }, { enabled: true })] });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Send" }, { ocr: false });
    expect(result).toEqual({
      ok: true,
      target: { point: { x: 140, y: 60 }, bounds: { x: 100, y: 50, width: 80, height: 20 }, source: "accessibility", name: "Send", role: "push button", enabled: true }
    });
  });

  it("scopes the AT-SPI search to the active window's process", async () => {
    const { context, findAccessibilityElement } = fakeContext({ candidates: [] });
    await resolveLabelTarget(context, ACTIVE, { label: "Send", role: "push button" }, { ocr: false });
    expect(findAccessibilityElement).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242, query: "Send", role: "push button" }));
    expect(findAccessibilityElement.mock.calls[0]?.[0]).not.toHaveProperty("appName");
  });

  it("falls back to the app name when the window has no pid", async () => {
    const { context, findAccessibilityElement } = fakeContext({ candidates: [] });
    await resolveLabelTarget(context, { appName: "Firefox" }, { label: "Send" }, { ocr: false });
    expect(findAccessibilityElement.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ appName: "Firefox" }));
    expect(findAccessibilityElement.mock.calls[0]?.[0]).not.toHaveProperty("pid");
  });

  it("refuses when the window names no app at all", async () => {
    const { context, findAccessibilityElement } = fakeContext({});
    const result = await resolveLabelTarget(context, { windowId: "w1" }, { label: "Send" }, { ocr: false });
    expect(findAccessibilityElement).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, code: "label_not_found" });
  });

  it("refuses an ambiguous name instead of picking one of two enabled matches", async () => {
    const { context } = fakeContext({
      candidates: [
        candidate("OK", { x: 10, y: 10, width: 60, height: 20 }, { enabled: true }),
        candidate("OK", { x: 300, y: 400, width: 60, height: 20 }, { enabled: true })
      ]
    });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "OK" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "label_ambiguous" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.candidates.map((item) => item.center)).toEqual([{ x: 40, y: 20 }, { x: 330, y: 410 }]);
  });

  it("uses the one enabled match when a disabled twin exists", async () => {
    const { context } = fakeContext({
      candidates: [
        candidate("Save", { x: 10, y: 10, width: 60, height: 20 }, { enabled: false }),
        candidate("Save", { x: 300, y: 400, width: 60, height: 20 }, { enabled: true })
      ]
    });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Save" }, { ocr: false });
    expect(result).toMatchObject({ ok: true, target: { point: { x: 330, y: 410 } } });
  });

  it("refuses a control that is disabled, and never clicks it", async () => {
    const { context } = fakeContext({ candidates: [candidate("Locked", { x: 20, y: 200, width: 200, height: 40 }, { enabled: false })] });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Locked" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "control_disabled" });
  });

  it("ignores matches outside the active window", async () => {
    const { context } = fakeContext({
      windows: { x: 0, y: 0, width: 400, height: 300 },
      candidates: [candidate("Send", { x: 900, y: 700, width: 80, height: 20 }, { enabled: true })]
    });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Send" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "label_not_found" });
  });

  it("never clicks a near miss; it lists the partial match as a suggestion", async () => {
    const { context } = fakeContext({ candidates: [candidate("Save as PDF", { x: 10, y: 10, width: 120, height: 20 }, { enabled: true })] });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Save" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "label_not_found" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.candidates.map((item) => item.name)).toEqual(["Save as PDF"]);
  });

  it("matches the role loosely: 'button' selects a 'push button' and nothing else", async () => {
    const link = candidate("Send", { x: 10, y: 10, width: 60, height: 20 }, { enabled: true, role: "link" });
    const { context } = fakeContext({ candidates: [link] });
    expect(await resolveLabelTarget(context, ACTIVE, { label: "Send", role: "button" }, { ocr: false })).toMatchObject({ ok: false, code: "label_not_found" });
    const { context: buttons } = fakeContext({ candidates: [candidate("Send", { x: 10, y: 10, width: 60, height: 20 }, { enabled: true })] });
    expect(await resolveLabelTarget(buttons, ACTIVE, { label: "Send", role: "button" }, { ocr: false })).toMatchObject({ ok: true });
  });

  it("ignores elements with no name or no size", async () => {
    const { context } = fakeContext({
      candidates: [
        candidate("", { x: 10, y: 10, width: 60, height: 20 }, { enabled: true }),
        candidate("Send", { x: 10, y: 10, width: 0, height: 20 }, { enabled: true })
      ]
    });
    expect(await resolveLabelTarget(context, ACTIVE, { label: "Send" }, { ocr: false })).toMatchObject({ ok: false, code: "label_not_found" });
  });

  it("matches case and spacing loosely, but the words must be the same", async () => {
    const { context } = fakeContext({ candidates: [candidate("  send   NOW ", { x: 10, y: 10, width: 60, height: 20 }, { enabled: true })] });
    expect(await resolveLabelTarget(context, ACTIVE, { label: "Send now" }, { ocr: false })).toMatchObject({ ok: true });
  });

  it("explains an unsupported AT-SPI backend when OCR is skipped", async () => {
    const { context } = fakeContext({ supported: false, reason: "The AT-SPI accessibility backend did not complete successfully." });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Send" }, { ocr: false });
    expect(result).toMatchObject({ ok: false, code: "label_not_found" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("did not complete successfully");
  });

  it("reports a lookup that cannot run at all when OCR also has no active window", async () => {
    const { context } = fakeContext({ supported: false, reason: "no atspi" });
    const result = await resolveLabelTarget(context, ACTIVE, { label: "Send" });
    expect(result).toMatchObject({ ok: false, code: "label_lookup_unavailable" });
  });
});
