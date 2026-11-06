import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginHandoff, beginTakeover, endHandoff, evaluateRunStateGate, readHandoff, readRunState } from "@agenthost/core";
import { HeadlessOverlayRenderer, OverlayManager } from "@agenthost/app-overlay";
import { HandoffOverlay } from "../handoff-overlay.js";

const SESSION = "handoff-test";
const directories: string[] = [];
async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenthost-handoff-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("human handoff", () => {
  it("halts state-changing tools until ended, and leaves an unrelated takeover alone", async () => {
    const home = await tempHome();
    await beginHandoff(home, { kind: "mfa", message: "Enter the code from your phone" });
    expect(await readHandoff(home)).toMatchObject({ active: true, kind: "mfa", message: "Enter the code from your phone" });
    expect(evaluateRunStateGate(await readRunState(home))).toMatchObject({ allowed: false, code: "human_takeover_active" });
    await endHandoff(home);
    expect((await readHandoff(home)).active).toBe(false);
    expect(evaluateRunStateGate(await readRunState(home)).allowed).toBe(true);

    await beginTakeover(home, "operator_takeover");
    await beginHandoff(home, { kind: "login", message: "Log in" });
    await beginTakeover(home, "operator_takeover");
    await endHandoff(home);
    expect((await readRunState(home)).takeover.requested).toBe(true);
  });

  it("shows a card, notifies once, and ends the handoff when the human presses Continue", async () => {
    const home = await tempHome();
    const manager = new OverlayManager(new HeadlessOverlayRenderer(), { sessionId: SESSION }, { hideMarkerPath: null });
    const notices: string[] = [];
    const overlay = new HandoffOverlay(manager, { agentHostDir: home, sessionId: SESSION, pollMs: 3_600_000, notify: (summary) => notices.push(summary) });
    try {
      await overlay.tick();
      expect(overlay.visible).toBe(false);
      await beginHandoff(home, { kind: "captcha", message: "Solve the puzzle" });
      await overlay.tick();
      await overlay.tick();
      expect(overlay.visible).toBe(true);
      expect(notices).toEqual(["AgentHost needs you"]);
      const payload = manager.suppressionSnapshot().find((entry) => entry.overlayId === overlay.widgetId)?.payload as { title: string; components: Array<{ type: string; event?: string }> };
      expect(payload.title).toBe("Your turn: solve the CAPTCHA");
      expect(payload.components.find((component) => component.type === "button")?.event).toBe("continue");

      manager.pushEvent({ eventId: "event_continue", overlayId: overlay.widgetId, event: "continue", createdAt: new Date().toISOString(), ownerSessionId: SESSION });
      await overlay.tick();
      expect(overlay.visible).toBe(false);
      expect((await readHandoff(home)).active).toBe(false);
      expect((await readRunState(home)).takeover.requested).toBe(false);

      // The CLI path (flag cleared elsewhere) removes the card without a button press.
      await beginHandoff(home, { kind: "login", message: "Log in" });
      await overlay.tick();
      expect(overlay.visible).toBe(true);
      await endHandoff(home);
      await overlay.tick();
      expect(overlay.visible).toBe(false);
    } finally {
      await overlay.close();
      await manager.close();
    }
  });
});
