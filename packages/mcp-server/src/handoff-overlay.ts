import type { OverlayManager } from "@osseo/app-overlay";
import { endHandoff, readHandoff, type HandoffKind, type HandoffState, type OverlayWidget } from "@osseo/core";

/*
 * The "Your turn" card. While a handoff is active (login, MFA, CAPTCHA,
 * payment) it tells the human what to do and offers one Continue button. The
 * agent cannot press it: the renderer accepts control presses only from a real
 * pointer outside Osseo's own input injection. `osseo agent resume
 * --takeover` ends the handoff too, and the card then disappears by itself.
 */

export interface HandoffOverlayOptions {
  osseoDir: string;
  sessionId: string;
  pollMs?: number;
  /** Best-effort desktop notification, sent once per handoff. */
  notify?: (summary: string, body: string) => void;
}

const TITLES: Record<HandoffKind, string> = {
  login: "Your turn: log in",
  mfa: "Your turn: enter the code",
  captcha: "Your turn: solve the CAPTCHA",
  payment: "Your turn: payment",
  other: "Your turn"
};

export class HandoffOverlay {
  readonly #manager: OverlayManager;
  readonly #options: HandoffOverlayOptions;
  readonly #widgetId: string;
  #timer: ReturnType<typeof setInterval> | undefined;
  #shownAt: string | undefined;
  #busy = false;
  #closed = false;

  constructor(manager: OverlayManager, options: HandoffOverlayOptions) {
    this.#manager = manager;
    this.#options = options;
    this.#widgetId = `osseo-handoff-${options.sessionId}`.slice(0, 120);
    this.#timer = setInterval(() => { void this.tick(); }, options.pollMs ?? 700);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  get widgetId(): string { return this.#widgetId; }
  get visible(): boolean { return this.#shownAt !== undefined; }

  widget(handoff: HandoffState): OverlayWidget {
    return {
      widgetId: this.#widgetId,
      title: TITLES[handoff.kind ?? "other"],
      components: [
        { type: "status_badge", status: "warning", text: "Waiting for you" },
        { type: "text", text: handoff.message ?? "The agent needs you to do the next step." },
        { type: "text", text: "Do it yourself, then press Continue. The agent cannot see your screen or type until you do." },
        { type: "button", label: "Continue", event: "continue" }
      ],
      placement: "top_center",
      style: { semantic: "warning", elevation: "high" },
      interaction: { interactive: true, focus: "never", dismissible: false, allowedEvents: ["continue"] },
      sensitivity: "public",
      ttlMs: 3_600_000,
      persistent: true
    };
  }

  async tick(): Promise<void> {
    if (this.#closed || this.#busy) return;
    this.#busy = true;
    try {
      const handoff = await readHandoff(this.#options.osseoDir);
      if (!handoff.active) {
        await this.#hide();
        return;
      }
      if (this.#shownAt === undefined || this.#shownAt !== handoff.at) {
        // A new handoff always gets a fresh card, even if one was left over.
        if (this.#shownAt !== undefined) await this.#hide();
        const result = await this.#manager.showWidget(this.widget(handoff));
        if (result.ok) {
          this.#shownAt = handoff.at ?? "";
          this.#options.notify?.("Osseo needs you", handoff.message ?? "Finish the step, then press Continue on the card.");
        }
        return;
      }
      const events = await this.#manager.pollEvents(this.#widgetId);
      if (events.some((event) => event.event === "continue")) {
        await endHandoff(this.#options.osseoDir);
        await this.#hide();
      }
    } catch {
      /* The card is advisory; the CLI can always end a handoff. */
    } finally {
      this.#busy = false;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#hide();
  }

  async #hide(): Promise<void> {
    if (this.#shownAt === undefined) return;
    this.#shownAt = undefined;
    await this.#manager.dismiss(this.#widgetId).catch(() => undefined);
  }
}
