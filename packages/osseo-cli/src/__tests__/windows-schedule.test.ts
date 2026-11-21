import { describe, expect, it } from "vitest";
import { buildSchtasksCreate, MAX_TASK_RUN_LENGTH, parseSchtasksList, quoteTaskArgument, windowsScheduleAdd, windowsScheduleList, windowsScheduleRemove, windowsTaskName, type SchtasksRun, type SchtasksRunner } from "../windows-schedule.js";

const base = { workflow: "morning-check", params: {}, nodePath: "C:\\Program Files\\nodejs\\node.exe", cliPath: "C:\\Users\\u\\AppData\\Local\\Osseo\\current\\bin\\osseo.mjs" };
function fake(run: Partial<SchtasksRun> = {}): { runner: SchtasksRunner; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, runner: (args) => { calls.push(args); return { status: 0, stdout: "", stderr: "", ...run }; } };
}

describe("Windows Task Scheduler commands", () => {
  it("builds a daily task for the current user without elevation", () => {
    const plan = buildSchtasksCreate({ ...base, schedule: { kind: "daily", time: "09:30" } });
    expect(plan.taskName).toBe("Osseo\\wf-morning-check");
    expect(plan.taskRun).toBe("\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\u\\AppData\\Local\\Osseo\\current\\bin\\osseo.mjs workflow run morning-check --unattended");
    expect(plan.args).toEqual(["/Create", "/TN", "Osseo\\wf-morning-check", "/TR", plan.taskRun, "/SC", "DAILY", "/ST", "09:30", "/RL", "LIMITED", "/F"]);
    expect(plan.args).not.toContain("/RU");
  });

  it("maps weekdays and intervals", () => {
    expect(buildSchtasksCreate({ ...base, schedule: { kind: "weekdays", time: "08:00" } }).args).toEqual(expect.arrayContaining(["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI", "/ST", "08:00"]));
    expect(buildSchtasksCreate({ ...base, schedule: { kind: "every", minutes: 30 } }).args).toEqual(expect.arrayContaining(["/SC", "MINUTE", "/MO", "30"]));
    expect(buildSchtasksCreate({ ...base, schedule: { kind: "every", minutes: 2880 } }).args).toEqual(expect.arrayContaining(["/SC", "DAILY", "/MO", "2"]));
    expect(() => buildSchtasksCreate({ ...base, schedule: { kind: "every", minutes: 1500 } })).toThrow(/schedule_interval_invalid_for_windows/);
  });

  it("refuses workflow names that could inject anything", () => {
    for (const name of ["a b", "a;b", "a&b", "a\"b", "a%b", "..", ".", "", "a".repeat(65), "x\\y", "x|y", "$(id)"]) {
      expect(() => windowsTaskName(name), name).toThrow("workflow_name_invalid");
      expect(() => buildSchtasksCreate({ ...base, workflow: name, schedule: { kind: "daily", time: "09:00" } })).toThrow();
    }
    expect(windowsTaskName("A_b.c-1")).toBe("Osseo\\wf-A_b.c-1");
  });

  it("quotes parameters and rejects characters that cannot be quoted", () => {
    expect(quoteTaskArgument("plain")).toBe("plain");
    expect(quoteTaskArgument("a b")).toBe("\"a b\"");
    expect(quoteTaskArgument("C:\\my dir\\")).toBe("\"C:\\my dir\\\\\"");
    for (const bad of ["a\"b", "50%", "a&b", "a|b", "a^b", "a<b", "a>b", "a\nb", ""]) expect(() => quoteTaskArgument(bad), bad).toThrow("schedule_argument_unsupported");
    const plan = buildSchtasksCreate({ ...base, params: { city: "New York" }, schedule: { kind: "daily", time: "09:00" } });
    expect(plan.taskRun.endsWith("--param \"city=New York\"")).toBe(true);
    expect(() => buildSchtasksCreate({ ...base, params: { q: "x & del *" }, schedule: { kind: "daily", time: "09:00" } })).toThrow("schedule_argument_unsupported");
    expect(() => buildSchtasksCreate({ ...base, params: { api_key: "sk-abcdefghijklmnopqrstuvwxyz0123456789" }, schedule: { kind: "daily", time: "09:00" } })).toThrow(/parameter_looks_secret/);
  });

  it("refuses a command line longer than schtasks accepts", () => {
    expect(() => buildSchtasksCreate({ ...base, params: { note: "x".repeat(MAX_TASK_RUN_LENGTH) }, schedule: { kind: "daily", time: "09:00" } })).toThrow(/schedule_command_too_long/);
  });

  it("previews by default and runs schtasks only with apply", () => {
    const preview = fake();
    const shown = windowsScheduleAdd({ ...base, schedule: { kind: "daily", time: "09:00" } }, false, preview.runner);
    expect(shown).toMatchObject({ ok: true, data: { preview: true, task: "Osseo\\wf-morning-check" } });
    expect(preview.calls).toEqual([]);
    const applied = fake();
    expect(windowsScheduleAdd({ ...base, schedule: { kind: "daily", time: "09:00" } }, true, applied.runner)).toEqual({ ok: true, data: { installed: "Osseo\\wf-morning-check" } });
    expect(applied.calls[0]![0]).toBe("/Create");
    const failed = fake({ status: 1, stderr: "ERROR: Access is denied." });
    expect(windowsScheduleAdd({ ...base, schedule: { kind: "daily", time: "09:00" } }, true, failed.runner)).toEqual({ ok: false, error: "schtasks_failed: ERROR: Access is denied." });
  });

  it("lists only Osseo workflow tasks and removes by exact name", () => {
    const csv = ["\"\\Osseo\\wf-b\",\"N/A\",\"Ready\"", "\"\\Microsoft\\Windows\\wf-x\",\"N/A\",\"Ready\"", "\"\\Osseo\\wf-a\",\"11/11/2026 9:00:00 AM\",\"Ready\"", "\"\\Osseo\\other\",\"N/A\",\"Ready\""].join("\r\n");
    expect(parseSchtasksList(csv)).toEqual(["a", "b"]);
    expect(windowsScheduleList(fake({ stdout: csv }).runner)).toEqual({ ok: true, data: { timers: ["a", "b"] } });
    const gone = fake();
    expect(windowsScheduleRemove("a", false, gone.runner)).toMatchObject({ ok: true, data: { preview: true, wouldRemove: ["Osseo\\wf-a"] } });
    expect(gone.calls).toEqual([]);
    expect(windowsScheduleRemove("a", true, gone.runner)).toEqual({ ok: true, data: { removed: "Osseo\\wf-a" } });
    expect(gone.calls).toEqual([["/Delete", "/TN", "Osseo\\wf-a", "/F"]]);
    expect(windowsScheduleRemove("a b", true, gone.runner)).toEqual({ ok: false, error: "workflow_name_invalid" });
  });
});
