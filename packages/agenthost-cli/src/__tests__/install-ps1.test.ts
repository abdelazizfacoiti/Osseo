import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { windowsCmdLauncher } from "../install-layout.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const text = readFileSync(path.join(ROOT, "scripts", "install.ps1"), "utf8");
const pwsh = ["pwsh", "powershell"].find((name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);

describe("scripts/install.ps1", () => {
  it("is ASCII and uses no PowerShell 7 syntax", () => {
    expect(/^[\x00-\x7F]*$/u.test(text)).toBe(true);
    const code = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\?\?|\?\.|&&|\|\||\s\?\s.+\s:\s/);
    expect(code).not.toMatch(/ForEach-Object\s+-Parallel|Get-Error|\$IsWindows|-Encoding\s+utf8NoBOM/i);
  });

  it("checks the hash, uses a temp folder it removes, and needs no admin or policy change", () => {
    expect(text).toContain("SHA-256 mismatch");
    expect(text).toMatch(/finally\s*\{[^}]*Remove-Item -LiteralPath \$work/);
    expect(text).toMatch(/GetEnvironmentVariable|OpenSubKey\("Environment"/);
    expect(text).not.toMatch(/Set-ExecutionPolicy|RunAs|-Verb\s+RunAs|HKLM|Machine"\)/i);
    expect(text).toContain("-DryRun");
    expect(text).toContain("-Help");
    expect(text).toContain("AGENTHOST_ARCHIVE_URL");
    expect(text).toContain("releases/latest/download/$Asset");
  });

  it("writes the same launcher line as the CLI documents", () => {
    const line = windowsCmdLauncher().split("\r\n").find((l) => l.startsWith("node "))!;
    expect(text).toContain(line.replaceAll("\"", "`\"").replace(" %*", " %*`r`n"));
  });

  it.skipIf(pwsh === undefined)("parses with PowerShell", () => {
    const script = `$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, "scripts", "install.ps1")}',[ref]$t,[ref]$e); if ($e.Count -gt 0) { $e | ForEach-Object { $_.Message }; exit 1 }`;
    expect(spawnSync(pwsh!, ["-NoProfile", "-Command", script], { encoding: "utf8" }).status).toBe(0);
  });
});
