import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listConfirmations, prepareConfirmation, validateOverlayWidget } from "@agenthost/core";
import { HeadlessOverlayRenderer, OverlayManager } from "@agenthost/app-overlay";
import { ApprovalOverlay } from "../approval-overlay.js";

const SESSION = "approval-test";
const directories: string[] = [];
async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenthost-approval-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function setup(home: string) {
  const manager = new OverlayManager(new HeadlessOverlayRenderer(), { sessionId: SESSION }, { hideMarkerPath: null });
  const overlay = new ApprovalOverlay(manager, { agentHostDir: home, sessionId: SESSION, pollMs: 3_600_000 });
  const press = (name: "accepted" | "rejected") => manager.pushEvent({ eventId: `event_${name}_${Math.random()}`, overlayId: overlay.widgetId ?? "missing", event: name, createdAt: new Date().toISOString(), ownerSessionId: SESSION });
  return { manager, overlay, press };
}
const request = (home: string, summary: string, sessionId: string = SESSION) => prepareConfirmation({ agentHostDir: home, tool: "file.delete", riskLevel: "high", args: { path: summary }, summary, sessionId });

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
      const { rejectConfirmation } = await import("@agenthost/core");
      await rejectConfirmation(home, mine.tokenId);
      await overlay.tick();
      expect(overlay.visible).toBe(false);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });
});
