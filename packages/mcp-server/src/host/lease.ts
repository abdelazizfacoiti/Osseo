/*
 * Host-wide lease for state-changing calls: one holder at a time, FIFO
 * waiters, a wait limit after which the waiter fails with host_busy and
 * nothing runs. Read-only calls never take it.
 */

export const DEFAULT_LEASE_WAIT_MS = 30_000;

export class HostBusyError extends Error {
  readonly code = "host_busy";
  constructor(readonly holder: string | undefined, readonly waitedMs: number) {
    super(`host_busy: another agent session${holder === undefined ? "" : ` (${holder})`} has held the computer for ${Math.round(waitedMs / 1000)} s. Nothing was executed; try again.`);
  }
}

export class LeaseCancelled extends Error {
  readonly code = "lease_cancelled";
  constructor() { super("lease_cancelled"); }
}

export type LeaseRelease = () => void;

interface Waiter {
  owner: string;
  resolve: (release: LeaseRelease) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  since: number;
}

export class HostLease {
  private holder: { owner: string; token: object } | undefined;
  private readonly queue: Waiter[] = [];

  constructor(private readonly waitMs = DEFAULT_LEASE_WAIT_MS) {}

  get holderLabel(): string | undefined { return this.holder?.owner; }
  get waiting(): number { return this.queue.length; }

  /** Resolves with a release function (idempotent). Rejects with HostBusyError after the wait limit, or LeaseCancelled. */
  acquire(owner: string, signal?: AbortSignal): Promise<LeaseRelease> {
    if (this.holder === undefined && this.queue.length === 0) return Promise.resolve(this.grant(owner));
    return new Promise<LeaseRelease>((resolve, reject) => {
      const waiter: Waiter = {
        owner, resolve, reject, since: Date.now(),
        timer: setTimeout(() => {
          this.remove(waiter);
          reject(new HostBusyError(this.holder?.owner, Date.now() - waiter.since));
        }, this.waitMs)
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", () => {
        if (this.remove(waiter)) reject(new LeaseCancelled());
      }, { once: true });
      if (signal?.aborted === true && this.remove(waiter)) reject(new LeaseCancelled());
    });
  }

  /** Runs `action` under the lease; the lease is freed in a finally. */
  async run<T>(owner: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(owner, signal);
    try { return await action(); } finally { release(); }
  }

  private remove(waiter: Waiter): boolean {
    const index = this.queue.indexOf(waiter);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    clearTimeout(waiter.timer);
    return true;
  }

  private grant(owner: string): LeaseRelease {
    const token = {};
    this.holder = { owner, token };
    return () => {
      if (this.holder?.token !== token) return;
      this.holder = undefined;
      const next = this.queue.shift();
      if (next === undefined) return;
      clearTimeout(next.timer);
      next.resolve(this.grant(next.owner));
    };
  }
}
