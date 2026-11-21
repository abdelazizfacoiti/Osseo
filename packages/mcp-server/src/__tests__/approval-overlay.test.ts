import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listConfirmations, prepareConfirmation, validateOverlayWidget } from "@osseo/core";
import { HeadlessOverlayRenderer, OverlayManager } from "@osseo/app-overlay";
import { ApprovalOverlay } from "../approval-overlay.js";

const SESSION = "approval-test";
const directories: string[] = [];
async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osseo-approval-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function setup(home: string) {
  const manager = new OverlayManager(new HeadlessOverlayRenderer(), { sessionId: SESSION }, { hideMarkerPath: null });
  const overlay = new ApprovalOverlay(manager, { osseoDir: home, sessionId: SESSION, pollMs: 3_600_000 });
  const press = (name: "accepted" | "always" | "rejected", overlayId?: string) => manager.pushEvent({ eventId: `event_${name}_${Math.random()}`, overlayId: overlayId ?? overlay.widgetId ?? "missing", event: name, createdAt: new Date().toISOString(), ownerSessionId: SESSION });
  return { manager, overlay, press };
}
const request = (home: string, summary: string, sessionId: string = SESSION) => prepareConfirmation({ osseoDir: home, tool: "file.delete", riskLevel: "high", args: { path: summary }, summary, sessionId });

describe("approval card", () => {
  it("shows the exact redacted preview, never the token, and approves only that token", async () => {
    const home = await tempHome();
    const { manager, overlay, press } = setup(home);
    try {
      const first = await request(home, "Delete report.txt (api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789)");
      await request(home, "Delete other.txt");
      await overlay.tick();
      expect(overlay.visible).toBe(true);
      const shown = manager.suppressionSnapshot().find((entry) => entry.overlayId === overlay.widgetId)?.payload as { title: string; components: Array<Record<string, unknown>> };
      expect(validateOverlayWidget({ ...shown, widgetId: overlay.widgetId } as never)).toEqual([]);
      const rendered = JSON.stringify(shown);
      expect(rendered).toContain("Delete report.txt");
      expect(rendered).toContain("1 more waiting");
      expect(rendered).not.toContain(first.tokenId);
      expect(rendered).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

      press("accepted");
      await overlay.tick();
      const after = await listConfirmations(home);
      expect(after.find((record) => record.tokenId === first.tokenId)?.status).toBe("accepted");
      expect(after.filter((record) => record.status === "accepted")).toHaveLength(1);

      // The next pending preview is shown only after the first is resolved.
      await overlay.tick();
      expect(overlay.visible).toBe(true);
      press("rejected");
      await overlay.tick();
      expect((await listConfirmations(home)).filter((record) => record.status === "rejected")).toHaveLength(1);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  it("ignores other sessions and hides the card when the CLI resolves the token", async () => {
    const home = await tempHome();
    const { manager, overlay } = setup(home);
    try {
      await request(home, "Delete elsewhere.txt", "another-session");
      await overlay.tick();
      expect(overlay.visible).toBe(false);
      const mine = await request(home, "Delete mine.txt");
      await overlay.tick();
      expect(overlay.visible).toBe(true);
      const { rejectConfirmation } = await import("@osseo/core");
      await rejectConfirmation(home, mine.tokenId);
      await overlay.tick();
      expect(overlay.visible).toBe(false);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  const slackSend = (home: string, category: "send" | "any" = "send") => prepareConfirmation({ osseoDir: home, tool: "desktop.click", riskLevel: "high", args: { n: Math.random() }, summary: "Send the message", sessionId: SESSION, policyTarget: { app: "Slack", category } });
  const hasFile = (home: string) => stat(path.join(home, "policy.toml")).then(() => true, () => false);

  it("offers Always allow here as a third button the renderer will accept", async () => {
    const home = await tempHome();
    const { manager, overlay } = setup(home);
    try {
      await slackSend(home);
      await overlay.tick();
      const shown = manager.suppressionSnapshot().find((entry) => entry.overlayId === overlay.widgetId)?.payload as { components: Array<{ type: string; label?: string; event?: string }>; interaction: { allowedEvents: string[] } };
      expect(shown.components.filter((entry) => entry.type === "button").map((entry) => [entry.label, entry.event])).toEqual([["Approve", "accepted"], ["Always allow here", "always"], ["Deny", "rejected"]]);
      expect(shown.interaction.allowedEvents).toEqual(["accepted", "always", "rejected"]);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  it("the always event approves once and writes the rule", async () => {
    const home = await tempHome();
    const { manager, overlay, press } = setup(home);
    try {
      const record = await slackSend(home);
      await overlay.tick();
      press("always");
      await overlay.tick();
      expect((await listConfirmations(home)).find((entry) => entry.tokenId === record.tokenId)?.status).toBe("accepted");
      const text = await readFile(path.join(home, "policy.toml"), "utf8");
      expect(text.split("\n").filter((line) => line.includes("added from an approval prompt"))).toHaveLength(1);
      expect(text).toContain("app = \"Slack\"\naction = \"send\"\ndecision = \"allow\"");
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  it("always on a category that cannot be remembered approves once and writes nothing", async () => {
    const home = await tempHome();
    const { manager, overlay, press } = setup(home);
    try {
      const record = await slackSend(home, "any");
      await overlay.tick();
      press("always");
      await overlay.tick();
      expect((await listConfirmations(home)).find((entry) => entry.tokenId === record.tokenId)?.status).toBe("accepted");
      expect(await hasFile(home)).toBe(false);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  it("an event for another card, or no event at all, changes nothing", async () => {
    const home = await tempHome();
    const { manager, overlay, press } = setup(home);
    try {
      const record = await slackSend(home);
      await overlay.tick();
      press("always", "osseo-approval-someone-else");
      await overlay.tick();
      expect((await listConfirmations(home)).find((entry) => entry.tokenId === record.tokenId)?.status).toBe("pending");
      expect(await hasFile(home)).toBe(false);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });

  it("the renderer treats always like accepted: physical press only", async () => {
    const source = await readFile(new URL("../../../app-overlay/runtime/gtk3-renderer.py", import.meta.url), "utf8");
    const setOf = (name: string): string[] => {
      const match = new RegExp(`^${name} = \\{([^}]*)\\}`, "m").exec(source);
      expect(match, name).not.toBeNull();
      return [...match![1]!.matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1]!);
    };
    for (const name of ["EVENTS", "TRUST_EVENTS", "CONTROL_EVENTS"]) expect(setOf(name), name).toContain("always");
    // Every set that holds accepted also holds always, so no check applies to one and not the other.
    for (const name of ["EVENTS", "TRUST_EVENTS", "CONTROL_EVENTS"]) {
      const set = setOf(name);
      expect(set.includes("accepted"), name).toBe(set.includes("always"));
    }
    // The press checks themselves are unchanged and still cover TRUST_EVENTS.
    expect(source).toContain("if event in TRUST_EVENTS and not self.visual.get(\"allowSyntheticControl\", False) and not physical_pointer_source():\n            return");
    expect(source).toContain("if event in CONTROL_EVENTS and (not pointer_activated() or self.agent_input_active()):\n            return");
  });
});
