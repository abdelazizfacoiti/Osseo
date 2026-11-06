import { acceptConfirmation, consumePhoneCode, formatPhoneRequest, listConfirmations, parsePhoneReply, phoneCovers, phoneRequestRef, readPhonePairing, rejectConfirmation } from "@agenthost/core";

/*
 * Sends pending confirmations to the paired channel and polls it for replies.
 * Outbound HTTP only. It polls only while something is pending, and a reply
 * makes the same decision as `agenthost confirm|deny`: approving lets the agent
 * retry that one exact action, once. See core/phone-approvals.ts for the trust
 * model. Nothing here runs unless the person has paired a phone.
 */

export interface PhoneBridgeOptions {
  agentHostDir: string;
  sessionId: string;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export class PhoneBridge {
  readonly #options: PhoneBridgeOptions;
  readonly #fetch: typeof fetch;
  readonly #published = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #since: string | undefined;
  #busy = false;

  constructor(options: PhoneBridgeOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timer = setInterval(() => { void this.tick(); }, options.pollMs ?? 5_000);
    (this.#timer as unknown as { unref?: () => void }).unref?.();
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const pairing = await readPhonePairing(this.#options.agentHostDir);
      if (pairing === undefined || pairing.disabled) return;
      const pending = (await listConfirmations(this.#options.agentHostDir))
        .filter((record) => record.status === "pending" && record.sessionId === this.#options.sessionId && phoneCovers(pairing, record.riskLevel));
      if (pending.length === 0) return;
      for (const record of pending) {
        if (this.#published.has(record.tokenId)) continue;
        const response = await this.#fetch(pairing.publishUrl, { method: "POST", body: formatPhoneRequest(record), headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(8_000) });
        if (response.ok) this.#published.add(record.tokenId);
      }
      const url = new URL(pairing.pollUrl);
      url.searchParams.set("poll", "1");
      url.searchParams.set("since", this.#since ?? String(Math.floor(Date.parse(pending[pending.length - 1]!.createdAt) / 1000)));
      const reply = await this.#fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!reply.ok) return;
      for (const line of (await reply.text()).split("\n")) {
        if (line.trim() === "") continue;
        let message: { id?: unknown; event?: unknown; message?: unknown };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        // Only message ids are valid cursors: `open` and `keepalive` events carry their own.
        if (typeof message.message !== "string" || (message.event !== undefined && message.event !== "message")) continue;
        if (typeof message.id === "string") this.#since = message.id;
        const parsed = parsePhoneReply(message.message);
        if (parsed === undefined) continue;
        const record = pending.find((entry) => phoneRequestRef(entry.tokenId) === parsed.ref);
        if (record === undefined) continue;
        // Spend the code first: a reply never gets a second try.
        if (!(await consumePhoneCode(this.#options.agentHostDir, parsed.code))) continue;
        await (parsed.decision === "approve" ? acceptConfirmation : rejectConfirmation)(this.#options.agentHostDir, record.tokenId).catch(() => undefined);
      }
    } catch {
      /* Best effort: the card and CLI still work if the channel is down. */
    } finally {
      this.#busy = false;
    }
  }

  close(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}
