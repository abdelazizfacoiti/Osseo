import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { aggregate, evaluateGate, markdownTable, median, mergeRuns, GATES } from "../../../scripts/benchmark-suite-aggregate.mjs";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, success: true, reported: true, conditionMet: true, refused: false, calls: 4, bytes: 1000, seconds: 1.5, ...over
});

describe("benchmark suite aggregation", () => {
  it("takes medians of odd and even lists and of nothing", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("summarises rates, medians and totals", () => {
    const rows = [row("a", { calls: 2, bytes: 100, seconds: 1 }), row("b", { calls: 4, bytes: 200, seconds: 2 }), row("c", { calls: 10, bytes: 300, seconds: 9 }), row("d", { success: false, conditionMet: false, reported: false, calls: 6, bytes: 400, seconds: 3 })];
    const summary = aggregate(rows);
    expect(summary).toMatchObject({ tasks: 4, succeeded: 3, failed: 1, successRate: 0.75, medianCalls: 5, totalCalls: 22, totalBytes: 1000, medianSeconds: 2.5, unverifiedSuccesses: 0 });
  });

  it("counts a reported success whose condition is false as unverified", () => {
    const rows = [row("a"), row("b", { success: false, reported: true, conditionMet: false }), row("c", { success: false, reported: false, conditionMet: false })];
    expect(aggregate(rows).unverifiedSuccesses).toBe(1);
    const gate = evaluateGate(aggregate(rows));
    expect(gate.unverifiedOk).toBe(false);
    expect(gate.pass).toBe(false);
  });

  it("counts refusals and does not treat them as failures", () => {
    const summary = aggregate([row("a", { refused: true }), row("b")]);
    expect(summary.refusals).toBe(1);
    expect(summary.successRate).toBe(1);
  });

  it("gates on success rate 0.9 and zero unverified successes", () => {
    expect(GATES).toEqual({ minSuccessRate: 0.9, maxUnverifiedSuccesses: 0 });
    const nine = Array.from({ length: 10 }, (_, index) => row(`t${index}`, index === 0 ? { success: false, reported: false, conditionMet: false } : {}));
    expect(evaluateGate(aggregate(nine)).pass).toBe(true);
    const eight = Array.from({ length: 10 }, (_, index) => row(`t${index}`, index < 2 ? { success: false, reported: false, conditionMet: false } : {}));
    expect(evaluateGate(aggregate(eight)).successRateOk).toBe(false);
    expect(evaluateGate(aggregate([])).pass).toBe(false);
  });

  it("merges runs into medians; one failed run fails the task", () => {
    const merged = mergeRuns([row("a", { calls: 4, bytes: 10, seconds: 1 }), row("a", { calls: 6, bytes: 30, seconds: 3 }), row("a", { calls: 5, bytes: 20, seconds: 2, success: false, reported: true, conditionMet: false })]);
    expect(merged).toMatchObject({ id: "a", runs: 3, successfulRuns: 2, success: false, calls: 5, bytes: 20, seconds: 2, unverifiedSuccess: true });
    expect(aggregate([merged]).unverifiedSuccesses).toBe(1);
  });

  it("renders a markdown row per task", () => {
    const table = markdownTable([mergeRuns([row("a")]), mergeRuns([row("b", { success: false, reported: true, conditionMet: false })])]);
    expect(table.split("\n")).toHaveLength(4);
    expect(table).toContain("| a | pass | 4 | 1000 | 1.5 | no |");
    expect(table).toContain("FAIL (unverified)");
  });
});
