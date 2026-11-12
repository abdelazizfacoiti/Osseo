import { describe, expect, it } from "vitest";
import { HostBusyError, HostLease } from "../host/lease.js";

describe("host lease", () => {
  it("grants in FIFO order", async () => {
    const lease = new HostLease(5000);
    const order: string[] = [];
    const first = await lease.acquire("a");
    const b = lease.acquire("b").then((r) => { order.push("b"); return r; });
    const c = lease.acquire("c").then((r) => { order.push("c"); return r; });
    expect(lease.waiting).toBe(2);
    first();
    (await b)();
    (await c)();
    expect(order).toEqual(["b", "c"]);
    expect(lease.holderLabel).toBeUndefined();
  });

  it("times out a waiter with host_busy and runs nothing", async () => {
    const lease = new HostLease(40);
    const held = await lease.acquire("holder");
    let ran = false;
    const error = await lease.run("waiter", async () => { ran = true; }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostBusyError);
    expect((error as HostBusyError).code).toBe("host_busy");
    expect(ran).toBe(false);
    expect(lease.waiting).toBe(0);
    held();
  });

  it("frees the lease when the holder releases twice or the action throws", async () => {
    const lease = new HostLease(200);
    await expect(lease.run("x", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(lease.holderLabel).toBeUndefined();
    const r = await lease.acquire("y");
    r(); r();
    await expect(lease.run("z", async () => 7)).resolves.toBe(7);
  });

  it("a cancelled waiter leaves the queue", async () => {
    const lease = new HostLease(5000);
    const held = await lease.acquire("h");
    const abort = new AbortController();
    const waiting = lease.acquire("w", abort.signal);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: "lease_cancelled" });
    expect(lease.waiting).toBe(0);
    held();
  });
});
