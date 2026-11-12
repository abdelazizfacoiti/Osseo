import path from "node:path";

/** Harmless card for checking that a real press is accepted. It changes nothing. */
export function pressCheck(agentHome: string, timeoutMs = 60_000): Promise<"allowed" | "denied" | "timed_out" | "overlay_unavailable"> {
  return pressCard(agentHome, { title: "Input check", badge: "Test only, nothing changes", text: "Press Allow with your mouse or touchpad. A press from a script or virtual mouse is ignored.", allow: "Allow", deny: "Cancel" }, timeoutMs);
}

async function pressCard(agentHome: string, card: { title: string; badge: string; text: string; allow: string; deny: string }, timeoutMs: number): Promise<"allowed" | "denied" | "timed_out" | "overlay_unavailable"> {
  const { createOverlayRenderer, OverlayManager } = await import("@agenthost/app-overlay");
  const sessionId = `cli-press-check-${process.pid}`;
  const renderer = createOverlayRenderer("auto", { sessionId, environment: process.env, inputGuardPath: path.join(agentHome, "run", "input-active") });
  try {
    if (!(await renderer.capabilities()).supported) return "overlay_unavailable";
    const manager = new OverlayManager(renderer, { sessionId }, { hideMarkerPath: null });
    const widgetId = `agenthost-press-check-${process.pid}`;
    const shown = await manager.showWidget({
      widgetId,
      title: card.title,
      components: [
        { type: "status_badge", status: "warning", text: card.badge },
        { type: "text", text: card.text },
        { type: "button", label: card.allow, event: "accepted" },
        { type: "button", label: card.deny, event: "rejected" }
      ],
      placement: "top_center",
      style: { semantic: "warning", elevation: "high" },
      interaction: { interactive: true, focus: "never", dismissible: false, allowedEvents: ["accepted", "rejected"] },
      sensitivity: "public",
      ttlMs: timeoutMs + 5_000,
      persistent: true
    });
    if (!shown.ok) return "overlay_unavailable";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await manager.pollEvents(widgetId);
      if (events.some((event) => event.event === "accepted")) return "allowed";
      if (events.some((event) => event.event === "rejected")) return "denied";
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return "timed_out";
  } finally {
    await renderer.close?.();
  }
}
