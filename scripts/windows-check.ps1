# AgentHost Windows check (W1: the headless path).
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows-check.ps1
#   (add -SkipInstall to reuse an existing node_modules folder)
#
# It runs from the repository folder. It installs nothing system-wide, changes no system settings,
# and writes only inside the repository and a temporary AgentHost home that it removes afterwards.
# Paste the whole output back; the last line says PASSED or FAILED.

param([switch]$SkipInstall)

$ErrorActionPreference = "Continue"
$script:failures = 0

function Invoke-Step([string]$Name, [scriptblock]$Body) {
    Write-Host ""
    Write-Host "== $Name"
    & $Body
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: $Name (exit code $LASTEXITCODE)"
        $script:failures = $script:failures + 1
    } else {
        Write-Host "PASS: $Name"
    }
}

Write-Host "AgentHost Windows check (W1, headless)"
Write-Host ("Windows: " + [System.Environment]::OSVersion.VersionString)
Write-Host ("PowerShell: " + $PSVersionTable.PSVersion.ToString())
Write-Host ("Folder: " + (Get-Location).Path)

if (-not (Test-Path "package.json")) {
    Write-Host "FAIL: run this from the AgentHost repository folder (package.json not found)."
    exit 1
}

Invoke-Step "Node 20 or newer" {
    node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
    node -p "'node ' + process.version"
}

if (-not $SkipInstall) {
    Invoke-Step "npm ci" { npm.cmd ci --no-audit --no-fund }
}

Invoke-Step "npm run build" { npm.cmd run build }
Invoke-Step "npm run lint" { npm.cmd run lint }
Invoke-Step "npm run test:windows (unit tests for the Windows path)" { npm.cmd run test:windows }
Invoke-Step "node scripts/windows-smoke.mjs (server over stdio, files, shell, browser, tasks)" { node scripts/windows-smoke.mjs }

Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "RESULT: PASSED (all steps)"
    exit 0
} else {
    Write-Host ("RESULT: FAILED (" + $script:failures + " step(s) failed)")
    exit 1
}
