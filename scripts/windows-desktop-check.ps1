# AgentHost Windows check (W2: the desktop adapter).
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows-desktop-check.ps1
#   (add -SkipInstall to reuse node_modules, -NoInput to skip the part that moves the mouse,
#    -ElevatedProbe to also check that an administrator window is refused)
#
# It builds, runs the unit tests, then starts the PowerShell helper and drives a small test window
# that it creates itself. It sends no input outside that window. Do not touch the mouse or keyboard
# for about 20 seconds while it runs. Paste the whole output back.

param([switch]$SkipInstall, [switch]$NoInput, [switch]$ElevatedProbe)

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

Write-Host "AgentHost Windows desktop check (W2)"
Write-Host ("Windows: " + [System.Environment]::OSVersion.VersionString)
Write-Host ("PowerShell: " + $PSVersionTable.PSVersion.ToString())
Write-Host ("Folder: " + (Get-Location).Path)

if (-not (Test-Path "package.json")) {
    Write-Host "FAIL: run this from the AgentHost repository folder (package.json not found)."
    exit 1
}

if (-not $SkipInstall) {
    Invoke-Step "npm ci" { npm.cmd ci --no-audit --no-fund }
}
Invoke-Step "npm run build" { npm.cmd run build }
Invoke-Step "npm run test:windows (unit tests for the Windows path)" { npm.cmd run test:windows }

$flags = @()
if ($NoInput) { $flags += "--no-input" }
if ($ElevatedProbe) { $flags += "--elevated-probe" }
Invoke-Step "node scripts/windows-desktop-smoke.mjs (helper, windows, screenshots, clipboard, test window)" { node scripts/windows-desktop-smoke.mjs @flags }

Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "RESULT: PASSED (all steps)"
    exit 0
} else {
    Write-Host ("RESULT: FAILED (" + $script:failures + " step(s) failed)")
    exit 1
}
