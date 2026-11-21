import { describe, expect, it } from "vitest";
import { buildScheduleUnits, exitCodeFor, parseParams, parseSchedule, summarizeRun } from "../workflow.js";

describe("workflow cli helpers", () => {
  it("parses repeated --param arguments and rejects bad ones", () => {
    expect(parseParams(["workflow", "run", "x", "--param", "week=45", "--param=who=Ada=Lovelace", "--unattended"])).toEqual({ week: "45", who: "Ada=Lovelace" });
    expect(() => parseParams(["--param", "novalue"])).toThrow(/parameter_invalid/);
    expect(() => parseParams(["--param", "bad-name=1"])).toThrow(/parameter_name_invalid/);
  });

  it("parses schedules strictly", () => {
    const flags = (entries: Array<[string, string]>) => new Map(entries);
    expect(parseSchedule(flags([["daily", "9:05"]]))).toEqual({ kind: "daily", time: "09:05" });
    expect(parseSchedule(flags([["weekdays", "18:00"]]))).toEqual({ kind: "weekdays", time: "18:00" });
    expect(parseSchedule(flags([["every", "2h"]]))).toEqual({ kind: "every", minutes: 120 });
    expect(() => parseSchedule(flags([]))).toThrow(/schedule_required/);
    expect(() => parseSchedule(flags([["daily", "09:00"], ["every", "30m"]]))).toThrow(/schedule_required/);
    expect(() => parseSchedule(flags([["daily", "25:00"]]))).toThrow(/schedule_time_invalid/);
    expect(() => parseSchedule(flags([["every", "1m"]]))).toThrow(/schedule_interval_invalid/);
  });

  it("builds systemd units that run the workflow unattended with escaped arguments", () => {
    const units = buildScheduleUnits({
      workflow: "open-report", schedule: { kind: "weekdays", time: "09:00" }, params: { note: 'a "b" 100% $HOME' },
      nodePath: "/usr/bin/node", cliPath: "/opt/osseo/cli.js", agentHome: "/home/u/.osseo",
      environment: { DISPLAY: ":0", XAUTHORITY: "/home/u/.Xauthority", SECRET_UNRELATED: "x" }
    });
    expect(units.unit).toBe("osseo-wf-open-report");
    expect(units.timer).toContain("OnCalendar=Mon..Fri *-*-* 09:00:00");
    expect(units.service).toContain("Type=oneshot");
    expect(units.service).toContain('Environment="DISPLAY=:0"');
    expect(units.service).toContain('Environment="OSSEO_HOME=/home/u/.osseo"');
    expect(units.service).not.toContain("SECRET_UNRELATED");
    expect(units.service).toContain('"workflow" "run" "open-report" "--unattended" "--param" "note=a \\"b\\" 100%% $$HOME"');
    expect(buildScheduleUnits({ workflow: "x1", schedule: { kind: "every", minutes: 30 }, params: {}, nodePath: "n", cliPath: "c", agentHome: "/h", environment: {} }).timer).toContain("OnUnitActiveSec=30min");
  });

  it("refuses secret-looking parameters and bad names", () => {
    const base = { schedule: { kind: "daily", time: "09:00" } as const, nodePath: "n", cliPath: "c", agentHome: "/h", environment: {} };
    expect(() => buildScheduleUnits({ ...base, workflow: "ok-name", params: { api_key: "sk-abcdefghijklmnopqrstuvwxyz0123456789" } })).toThrow(/parameter_looks_secret/);
    expect(() => buildScheduleUnits({ ...base, workflow: "../evil", params: {} })).toThrow(/workflow_name_invalid/);
  });

  it("maps run results to statuses and exit codes without ever treating approval as success", () => {
    expect(summarizeRun("w", 3, { ok: true })).toEqual({ status: "completed", workflow: "w", steps: 3 });
    const needs = summarizeRun("w", 3, { ok: false, error: { code: "confirmation_required", message: "Needs approval" } });
    expect(needs.status).toBe("needs_approval");
    expect(exitCodeFor(needs.status)).toBe(2);
    expect(exitCodeFor(summarizeRun("w", 1, { ok: false, error: { code: "emergency_stop_requested" } }).status)).toBe(3);
    expect(exitCodeFor(summarizeRun("w", 1, { ok: false, error: { code: "invalid_input" } }).status)).toBe(1);
  });
});
