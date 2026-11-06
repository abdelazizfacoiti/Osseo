import { createHash } from "node:crypto";
import type { OverlayManager } from "@agenthost/app-overlay";
import { acceptConfirmation, listConfirmations, redactSensitiveText, rejectConfirmation, type ConfirmationRecord, type OverlayWidget } from "@agenthost/core";

/*
 * Approve or deny a pending confirmation from the screen, the same decision
 * `agenthost confirm|deny <tokenId>` makes. One card is shown per pending
 * token, oldest first, and each card is bound to its own token through the
 * widget id, so a press can only ever resolve the preview the person is
 * looking at. The token itself is never shown.
 *
 * The renderer accepts Approve/Deny only from a real pointer: keyboard,
 * accessibility "click" actions, AgentHost's own input injection and synthetic
 * XTEST clicks are all ignored. Approving only lets the agent retry that one
 * exact action once; it does not run anything by itself.
 */

export interface ApprovalOverlayOptions {
  agentHostDir: string;
  /** Only confirmations created by this server session are shown. */
  sessionId: string;
  pollMs?: number;
}

function cardId(sessionId: string, tokenId: string): string {
  return `agenthost-approval-${createHash("sha256").update(`${sessionId}:${tokenId}`).digest("hex").slice(0, 24)}`;
}

function describeRisk(record: ConfirmationRecord): string {
  return record.riskLevel === "high" ? "High risk" : record.riskLevel === "medium" ? "Medium risk" : "Needs approval";
}

export class ApprovalOverlay {
  readonly #manager: OverlayManager;
  readonly #options: ApprovalOverlayOptions;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** Card currently on screen and the token it resolves. */
  #shown: { widgetId: string; tokenId: string } | undefined;
  #busy = false;
  #closed = false;

  constructor(manager: OverlayManager, options: ApprovalOverlayOptions) {
    this.#manager = manager;
    this.#options = options;
    this.#timer = setInterval(() => { void this.tick(); }, options.pollMs ?? 700);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  get visible(): boolean { return this.#shown !== undefined; }
  get widgetId(): string | undefined { return this.#shown?.widgetId; }

  widget(record: ConfirmationRecord, widgetId: string, others: number): OverlayWidget {
    const minutes = Math.max(0, Math.round((Date.parse(record.expiresAt) - Date.now()) / 60_000));
    return {
      widgetId,
      title: "Approve this action?",
      components: [
        { type: "status_badge", status: "warning", text: describeRisk(record) },
        { type: "text", text: redactSensitiveText(record.summary).slice(0, 400) },
        { type: "key_value", key: "Tool", value: record.tool.slice(0, 60) },
        { type: "text", text: `Allows this one exact action, once. Expires in ${minutes} min.${others > 0 ? ` ${others} more waiting.` : ""}` },
        { type: "button", label: "Approve", event: "accepted" },
        { type: "button", label: "Deny", event: "rejected" }
      ],
      placement: "top_center",
      style: { semantic: "warning", elevation: "high" },
      interaction: { interactive: true, focus: "never", dismissible: false, allowedEvents: ["accepted", "rejected"] },
      sensitivity: "public",
      ttlMs: 900_000,
      persistent: true
    };
  }

  async tick(): Promise<void> {
    if (this.#closed || this.#busy) return;
    this.#busy = true;
    try {
      const pending = (await listConfirmations(this.#options.agentHostDir))
        .filter((record) => record.status === "pending" && record.sessionId === this.#options.sessionId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const shown = this.#shown;
      if (shown !== undefined) {
        const current = pending.find((record) => record.tokenId === shown.tokenId);
        if (current === undefined) {
          // Resolved elsewhere (CLI) or expired.
          await this.#hide();
        } else {
          const events = await this.#manager.pollEvents(shown.widgetId);
          const decision = events.find((event) => event.overlayId === shown.widgetId && (event.event === "accepted" || event.event === "rejected"));
          if (decision !== undefined) {
            await (decision.event === "accepted" ? acceptConfirmation : rejectConfirmation)(this.#options.agentHostDir, shown.tokenId).catch(() => undefined);
            await this.#hide();
            return;
          }
          return;
        }
      }
      const next = pending[0];
      if (next === undefined) return;
      const widgetId = cardId(this.#options.sessionId, next.tokenId);
      const result = await this.#manager.showWidget(this.widget(next, widgetId, pending.length - 1));
      if (result.ok) this.#shown = { widgetId, tokenId: next.tokenId };
    } catch {
      /* The card is advisory; the CLI can always resolve a confirmation. */
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
    const shown = this.#shown;
    if (shown === undefined) return;
    this.#shown = undefined;
    await this.#manager.dismiss(shown.widgetId).catch(() => undefined);
  }
}
