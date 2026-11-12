import type { OverlayCapabilityReport, OverlayStateSnapshot, OverlayWidgetEvent } from "@agenthost/core";
import type {
  OverlayOperationResult, OverlayRenderRecord, OverlayRenderer, OverlayRendererDiagnostics, OverlayRendererRestartResult
} from "@agenthost/app-overlay";

/*
 * One overlay renderer for the whole host service. The hub owns the renderer;
 * every session gets a SessionRendererProxy that looks like an OverlayRenderer.
 *
 * Routing rule: the proxy puts "<sessionId>::" in front of every overlay id it
 * sends down and takes it off on the way back. A renderer event goes to the
 * session whose id is the text before the first "::" of the event's overlayId;
 * an event with no such session is dropped and counted.
 *
 * Global operations: emergencyHide() and restartRenderer (restart()) act on the
 * one renderer, so they affect every session. This is deliberate: a Stop must
 * hide everything. clear() is per session (it dismisses only that session's
 * overlays). close() on a proxy is a no-op; the hub closes the renderer.
 */

const SEPARATOR = "::";
const MAX_QUEUED_EVENTS = 200;
export const DEFAULT_RENDERER_DRAIN_MS = 250;

export interface SharedRendererHubOptions {
  drainMs?: number;
}

export class SharedRendererHub {
  readonly #renderer: OverlayRenderer;
  readonly #drainMs: number;
  readonly #proxies = new Map<string, SessionRendererProxy>();
  #timer: NodeJS.Timeout | undefined;
  #draining = false;
  #dropped = 0;
  #closed = false;

  constructor(renderer: OverlayRenderer, options: SharedRendererHubOptions = {}) {
    this.#renderer = renderer;
    this.#drainMs = options.drainMs ?? DEFAULT_RENDERER_DRAIN_MS;
  }

  /** Events that matched no session since the hub started. */
  get droppedEventCount(): number { return this.#dropped; }
  get sessionCount(): number { return this.#proxies.size; }
  get closed(): boolean { return this.#closed; }
  /** The shared renderer; for status and tests only. */
  get renderer(): OverlayRenderer { return this.#renderer; }

  /** The proxy for a session; the same proxy while the session is registered. */
  proxyFor(sessionId: string): SessionRendererProxy {
    const existing = this.#proxies.get(sessionId);
    if (existing !== undefined) return existing;
    if (sessionId.length === 0 || sessionId.includes(SEPARATOR)) throw new Error("invalid_session_id");
    const proxy = new SessionRendererProxy(this, this.#renderer, sessionId);
    this.#proxies.set(sessionId, proxy);
    if (this.#timer === undefined && !this.#closed) {
      this.#timer = setInterval(() => { void this.drainNow(); }, this.#drainMs);
      this.#timer.unref();
    }
    return proxy;
  }

  /** The session is gone: take its overlays off the screen and forget it. Other sessions are untouched. */
  async release(sessionId: string): Promise<void> {
    const proxy = this.#proxies.get(sessionId);
    if (proxy === undefined) return;
    await proxy.clear().catch(() => undefined);
    this.#proxies.delete(sessionId);
    if (this.#proxies.size === 0 && this.#timer !== undefined) { clearInterval(this.#timer); this.#timer = undefined; }
  }

  /** Pull events from the renderer once and hand each to its session. Overlapping calls do nothing. */
  async drainNow(): Promise<void> {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    try {
      const events = await (this.#renderer.drainEvents?.() ?? this.#renderer.events());
      for (const event of events) this.#route(event);
    } catch {
      /* A failed drain is retried on the next tick. */
    } finally {
      this.#draining = false;
    }
  }

  /** @internal Called by proxies after a global operation: every overlay is gone from the renderer. */
  forgetAllOverlays(): void { for (const proxy of this.#proxies.values()) proxy.forgetOverlays(); }

  #route(event: OverlayWidgetEvent): void {
    const cut = event.overlayId.indexOf(SEPARATOR);
    const proxy = cut > 0 ? this.#proxies.get(event.overlayId.slice(0, cut)) : undefined;
    if (proxy === undefined) { this.#dropped += 1; return; }
    proxy.deliver({ ...event, overlayId: event.overlayId.slice(cut + SEPARATOR.length), ownerSessionId: proxy.sessionId });
  }

  /** Stop the timer and close the renderer. The host calls this once, when it exits. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#proxies.clear();
    await this.#renderer.close?.();
  }
}

export class SessionRendererProxy implements OverlayRenderer {
  readonly #hub: SharedRendererHub;
  readonly #renderer: OverlayRenderer;
  readonly sessionId: string;
  readonly #own = new Set<string>();
  #events: OverlayWidgetEvent[] = [];

  constructor(hub: SharedRendererHub, renderer: OverlayRenderer, sessionId: string) {
    this.#hub = hub;
    this.#renderer = renderer;
    this.sessionId = sessionId;
    const diagnostics = renderer.diagnostics?.bind(renderer);
    if (diagnostics !== undefined) this.diagnostics = diagnostics;
  }

  #wire(overlayId: string): string { return `${this.sessionId}${SEPARATOR}${overlayId}`; }

  capabilities(): Promise<OverlayCapabilityReport> | OverlayCapabilityReport { return this.#renderer.capabilities(); }

  async show(record: OverlayRenderRecord): Promise<OverlayOperationResult> {
    const wire = this.#wire(record.overlayId);
    const result = await this.#renderer.show({ ...record, overlayId: wire });
    if (result.ok) this.#own.add(wire);
    return result;
  }

  async update(record: OverlayRenderRecord): Promise<OverlayOperationResult> {
    return await this.#renderer.update({ ...record, overlayId: this.#wire(record.overlayId) });
  }

  async dismiss(overlayId: string): Promise<OverlayOperationResult> {
    const wire = this.#wire(overlayId);
    this.#own.delete(wire);
    return await this.#renderer.dismiss(wire);
  }

  /** Per session: dismisses only the overlays this session showed. */
  async clear(): Promise<OverlayOperationResult> {
    const ids = [...this.#own];
    this.#own.clear();
    for (const id of ids) try { await this.#renderer.dismiss(id); } catch { /* best effort */ }
    return { ok: true, reason: "overlays_cleared", acknowledged: true };
  }

  /** GLOBAL: hides every session's overlays, because one renderer serves everyone and Stop must hide everything. */
  async emergencyHide(): Promise<OverlayOperationResult> {
    const result = await this.#renderer.emergencyHide();
    this.#hub.forgetAllOverlays();
    return result;
  }

  /** GLOBAL: restarts the one renderer, so every session's cards are gone until it redraws them. */
  async restart(): Promise<OverlayRendererRestartResult> {
    const result = await this.#renderer.restart?.();
    this.#hub.forgetAllOverlays();
    return result ?? { ok: false, reason: "overlay_renderer_restart_unsupported" };
  }

  async state(): Promise<OverlayStateSnapshot> {
    const snapshot = await this.#renderer.state();
    return { ...snapshot, overlays: [], pendingEvents: [...this.#events] };
  }

  events(): OverlayWidgetEvent[] { return [...this.#events]; }

  /** This session's events only, taken from the queue the hub fills on its timer. */
  drainEvents(): OverlayWidgetEvent[] {
    const out = this.#events;
    this.#events = [];
    return out;
  }

  /** Forwarded when the shared renderer has it; absent otherwise, so the manager keeps its own fallback. */
  readonly diagnostics?: () => Promise<OverlayRendererDiagnostics> | OverlayRendererDiagnostics;

  async warmup(): Promise<void> { await this.#renderer.warmup?.(); }

  /** A session never closes the shared renderer; the hub does when the host exits. */
  close(): void { /* no-op */ }

  /** Events a session pushes itself (the manager's local hide events) stay in its own queue. */
  pushEvent(event: OverlayWidgetEvent): void { this.deliver(event); }

  /** @internal */
  deliver(event: OverlayWidgetEvent): void {
    this.#events.push(event);
    if (this.#events.length > MAX_QUEUED_EVENTS) this.#events.splice(0, this.#events.length - MAX_QUEUED_EVENTS);
  }

  /** @internal */
  forgetOverlays(): void { this.#own.clear(); }
}
