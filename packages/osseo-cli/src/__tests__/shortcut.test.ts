import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shortcutCommand, shQuote, wrapperContent, parseStringList, type RunResult } from "../shortcut.js";

const SLOT = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/osseo-stop/";
const OTHER = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/";
let home = "";
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), "ah-sc-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Fake gsettings holding a list and the slot keys. */
function fake(initialList: string[], slot: Record<string, string> = {}) {
  let list = [...initialList];
  const keys: Record<string, string> = { ...slot };
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "get" && args[2] === "custom-keybindings") return ok(list.length === 0 ? "@as []\n" : `[${list.map((i) => `'${i}'`).join(", ")}]\n`);
    if (args[0] === "get") return ok(`'${keys[args[2]!] ?? ""}'\n`);
    if (args[0] === "set" && args[2] === "custom-keybindings") { list = parseStringList(args[3]!); return ok(); }
    if (args[0] === "set") { keys[args[2]!] = args[3]!; return ok(); }
    if (args[0] === "reset") { delete keys[args[2]!]; return ok(); }
    return { status: 1, stdout: "", stderr: "bad" };
  };
  return { run, calls, get list() { return list; }, keys };
}
const gnome = (f: ReturnType<typeof fake>, extra = {}) => ({ run: f.run, env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, hasGsettings: () => true, exists: () => true, cliEntry: "/opt/ah/cli.js", node: "/usr/bin/node", ...extra });
const wrapper = () => path.join(home, "bin", "osseo-stop");

describe("shortcut", () => {
  it("quotes a space and a single quote for sh", () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(wrapperContent("/n d/node", "/c'x/cli.js")).toBe(`#!/bin/sh\nexec '/n d/node' '/c'\\''x/cli.js' 'agent' 'stop' '--reason' 'shortcut'\n`);
  });

  it("previews without writing or calling gsettings", async () => {
    const f = fake([]);
    const r = await shortcutCommand(["install"], home, gnome(f));
    expect(r.ok).toBe(true);
    expect((r.data as any).applied).toBe(false);
    expect((r.data as any).wrapperContent).toContain("exec '/usr/bin/node' '/opt/ah/cli.js'");
    expect(f.calls).toEqual([]);
    expect(existsSync(wrapper())).toBe(false);
    const rm = await shortcutCommand(["remove"], home, gnome(f));
    expect(rm.ok).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("apply writes a 0700 wrapper and keeps other entries", async () => {
    const f = fake([OTHER]);
    const r = await shortcutCommand(["install", "--apply"], home, gnome(f));
    expect(r.ok).toBe(true);
    expect(readFileSync(wrapper(), "utf8")).toBe(wrapperContent("/usr/bin/node", "/opt/ah/cli.js"));
    expect(statSync(wrapper()).mode & 0o777).toBe(0o700);
    expect(statSync(path.dirname(wrapper())).mode & 0o777).toBe(0o700);
    expect(f.list).toEqual([OTHER, SLOT]);
    expect(f.keys.name).toBe("Osseo stop");
    expect(f.keys.command).toBe(wrapper());
    expect(f.keys.binding).toBe("<Control><Shift><Alt>Escape");
  });

  it("second install is a no-op", async () => {
    const f = fake([OTHER]);
    await shortcutCommand(["install", "--apply"], home, gnome(f));
    const before = f.calls.length;
    const r = await shortcutCommand(["install", "--apply"], home, gnome(f));
    expect(r.ok).toBe(true);
    expect((r.data as any).alreadyInstalled).toBe(true);
    expect(f.calls.slice(before).every((c) => c[1] === "get")).toBe(true);
  });

  it("refuses when the slot has a different command", async () => {
    const f = fake([SLOT], { command: "/bin/other", binding: "<Super>x" });
    const r = await shortcutCommand(["install", "--apply"], home, gnome(f));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binding_conflict/);
    expect(f.calls.some((c) => c[1] === "set")).toBe(false);
    expect(existsSync(wrapper())).toBe(false);
  });

  it("remove drops only ours and the wrapper", async () => {
    const f = fake([OTHER]);
    await shortcutCommand(["install", "--apply"], home, gnome(f));
    const r = await shortcutCommand(["remove", "--apply"], home, gnome(f));
    expect(r.ok).toBe(true);
    expect(f.list).toEqual([OTHER]);
    expect(f.keys.command).toBeUndefined();
    expect(existsSync(wrapper())).toBe(false);
  });

  it("status reports the binding", async () => {
    const f = fake([OTHER]);
    await shortcutCommand(["install", "--apply", "--binding", "<Super>F12"], home, gnome(f));
    const r = await shortcutCommand(["status"], home, gnome(f));
    expect((r.data as any).installed).toBe(true);
    expect((r.data as any).binding).toBe("<Super>F12");
  });

  it("refuses unsupported desktops without any call", async () => {
    for (const d of [{ env: { XDG_CURRENT_DESKTOP: "KDE" }, hasGsettings: () => true }, { env: { XDG_CURRENT_DESKTOP: "GNOME" }, hasGsettings: () => false }]) {
      const f = fake([]);
      const r = await shortcutCommand(["install", "--apply"], home, { ...gnome(f), ...d });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^unsupported_desktop/);
      expect(f.calls).toEqual([]);
      expect(existsSync(wrapper())).toBe(false);
    }
  });

  it("refuses an invalid accelerator and a missing CLI entry before any call", async () => {
    const f = fake([]);
    for (const b of ["<Control>; rm", "", "a b", "<Ctrl>"+"'x"]) {
      const r = await shortcutCommand(["install", "--apply", "--binding", b], home, gnome(f));
      expect(r.ok).toBe(false);
    }
    const missing = await shortcutCommand(["install", "--apply"], home, gnome(f, { exists: () => false }));
    expect(missing.error).toMatch(/cli_entry_not_found/);
    expect(f.calls).toEqual([]);
  });
});
