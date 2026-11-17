import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WINDOWS_OVERLAY_SCRIPT } from "../windows-overlay-script.js";

const SOURCE = readFileSync(new URL("../windows-overlay-script.ts", import.meta.url), "utf8");
const pwsh = ["pwsh", "powershell"].find((name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);

describe("windows-overlay-script", () => {
  it("is ASCII in the TypeScript source, so the file encoding cannot change the embedded code", () => {
    expect(/^[\x00-\x7F]*$/u.test(SOURCE)).toBe(true);
  });

  it("holds the real-press guard, the protocol commands and the Win32 bindings it needs", () => {
    for (const needle of [
      "SetWindowsHookExW",
      "ReadInt32($lParam, 12)",
      "PreviewMouseLeftButtonDown",
      "PreviewMouseLeftButtonUp",
      "SHAppBarMessage",
      "Invoke-OvRunCommand",
      "wpf-windows",
      "emergency_hide",
      "emergency_hidden",
      "renderer_token_invalid",
      "overlay_input_guard_unavailable"
    ]) {
      expect(WINDOWS_OVERLAY_SCRIPT, needle).toContain(needle);
    }
  });

  it("reads JSON arrays as any IList: JavaScriptSerializer returns ArrayList for Dictionary<string, object>, so an object[]-only check left every card without a body", () => {
    expect(WINDOWS_OVERLAY_SCRIPT).toContain("-isnot [System.Collections.IList]");
    expect(WINDOWS_OVERLAY_SCRIPT).not.toContain("-is [object[]]");
  });

  it("compiles nothing at run time, so no DLL is written: the Win32 bindings come from NATIVE_PS in memory", () => {
    expect(WINDOWS_OVERLAY_SCRIPT).not.toMatch(/Add-Type\s+-TypeDefinition/i);
    expect(WINDOWS_OVERLAY_SCRIPT).not.toMatch(/-MemberDefinition/i);
    expect(WINDOWS_OVERLAY_SCRIPT).not.toMatch(/Add-Type\s+-Namespace/i);
    expect(WINDOWS_OVERLAY_SCRIPT).not.toMatch(/-Language\s+CSharp/i);
    expect(WINDOWS_OVERLAY_SCRIPT).toContain("DefineDynamicAssembly");
    expect(WINDOWS_OVERLAY_SCRIPT).toContain("Initialize-AhNative");
  });

  it("cannot break its template literal: no backtick, no dollar-brace, CRLF line endings only", () => {
    expect(WINDOWS_OVERLAY_SCRIPT).not.toContain("`");
    expect(WINDOWS_OVERLAY_SCRIPT).not.toContain("${");
    expect(WINDOWS_OVERLAY_SCRIPT).not.toMatch(/[^\r]\n/);
  });

  it.skipIf(pwsh === undefined)("parses as PowerShell with no compile step", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "agenthost-win-overlay-parse-"));
    try {
      const file = path.join(dir, "overlay.ps1");
      writeFileSync(file, WINDOWS_OVERLAY_SCRIPT, "utf8");
      const script = `$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e); if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 }`;
      expect(spawnSync(pwsh!, ["-NoProfile", "-Command", script], { encoding: "utf8" }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
