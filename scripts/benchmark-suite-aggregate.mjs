/*
 * Pure aggregation for the benchmark suite (scripts/benchmark-suite.mjs). No I/O, so a unit test can
 * feed it fake task results.
 *
 * A task result looks like:
 *   { id, success, reported, conditionMet, refused, calls, bytes, seconds }
 *
 * "reported" is true when the driver finished without an unexpected error, that is, when an agent
 * following the same steps would have said it was done. "conditionMet" is the harness's own check of
 * the page afterwards. An unverified success is reported === true with conditionMet === false.
 */

export const GATES = { minSuccessRate: 0.9, maxUnverifiedSuccesses: 0 };

/** Median of numbers; the mean of the two middle values for an even count; 0 for an empty list. */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * Several runs of one task become one row: the metrics are medians. The task succeeded only when
 * every run succeeded, and it counts as an unverified success when any run was one.
 */
export function mergeRuns(runs) {
  if (runs.length === 0) throw new Error("mergeRuns needs at least one run");
  const first = runs[0];
  return {
    id: first.id,
    runs: runs.length,
    successfulRuns: runs.filter((run) => run.success).length,
    success: runs.every((run) => run.success),
    reported: runs.every((run) => run.reported),
    conditionMet: runs.every((run) => run.conditionMet),
    unverifiedSuccess: runs.some((run) => run.reported && !run.conditionMet),
    refused: runs.every((run) => run.refused),
    calls: median(runs.map((run) => run.calls)),
    bytes: median(runs.map((run) => run.bytes)),
    seconds: round(median(runs.map((run) => run.seconds)), 2)
  };
}

/** The numbers the suite reports over a list of per-task rows (one row per task). */
export function aggregate(rows) {
  const total = rows.length;
  const succeeded = rows.filter((row) => row.success).length;
  const unverified = rows.filter((row) => row.unverifiedSuccess ?? (row.reported === true && row.conditionMet !== true)).length;
  return {
    tasks: total,
    succeeded,
    failed: total - succeeded,
    successRate: total === 0 ? 0 : round(succeeded / total, 4),
    medianCalls: median(rows.map((row) => row.calls)),
    totalCalls: rows.reduce((sum, row) => sum + row.calls, 0),
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    medianSeconds: round(median(rows.map((row) => row.seconds)), 2),
    totalSeconds: round(rows.reduce((sum, row) => sum + row.seconds, 0), 1),
    refusals: rows.filter((row) => row.refused).length,
    unverifiedSuccesses: unverified
  };
}

/** The CI gate: success rate at least the minimum and no unverified successes. */
export function evaluateGate(summary, gates = GATES) {
  const successRateOk = summary.tasks > 0 && summary.successRate >= gates.minSuccessRate;
  const unverifiedOk = summary.unverifiedSuccesses <= gates.maxUnverifiedSuccesses;
  return { successRateOk, unverifiedOk, pass: successRateOk && unverifiedOk, gates };
}

export function markdownTable(rows) {
  const lines = ["| task | result | calls | bytes | seconds | refused |", "|---|---|---:|---:|---:|---|"];
  for (const row of rows) {
    const result = row.success ? "pass" : row.unverifiedSuccess ? "FAIL (unverified)" : "FAIL";
    lines.push(`| ${row.id} | ${result} | ${row.calls} | ${row.bytes} | ${row.seconds} | ${row.refused ? "yes" : "no"} |`);
  }
  return lines.join("\n");
}
