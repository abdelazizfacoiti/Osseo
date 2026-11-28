# Builds and installs Osseo from this clone on Windows, in one command. PowerShell 5.1 or newer. ASCII only.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-from-source.ps1 [-NoCards] [-DryRun]
#
# It needs Node 20+ and no administrator rights, and it does not change the execution policy
# (it calls npm.cmd, which the default policy allows). Run it again after "git pull" to update.
# -NoCards leaves the on-screen cards as they are. Without it they are turned on, unless
# config.json already says "windows": false.

param(
    [switch]$NoCards,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Total = 5

function Say([string]$Text) { Write-Host $Text }

function Invoke-Step([int]$Number, [string]$Title, [string]$Program, [string[]]$Arguments) {
    Say ""
    Say ("[" + $Number + "/" + $Total + "] " + $Title)
    if ($DryRun) { Say ("      would run: " + $Program + " " + ($Arguments -join " ")); return }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Program @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($code -ne 0) { throw ($Title + " failed (exit " + $code + "). Fix the error above, then run this script again.") }
}

# Adds "overlay": { "windows": true } and keeps every other setting. Written without a byte order mark.
function Enable-Cards {
    $dir = Join-Path $env:APPDATA "osseo"
    $file = Join-Path $dir "config.json"
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        [System.IO.File]::WriteAllText($file, '{ "schemaVersion": 1, "overlay": { "windows": true } }', $utf8)
        Say "Cards are on."
        return
    }
    try {
        $config = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
    } catch {
        Say ("Cards were not changed: " + $file + " is not valid JSON.")
        return
    }
    if ($null -eq $config.PSObject.Properties["overlay"]) {
        $config | Add-Member -NotePropertyName overlay -NotePropertyValue (New-Object PSObject)
    }
    if ($null -ne $config.overlay.PSObject.Properties["windows"]) {
        Say ('Cards setting kept: "windows": ' + ([string]$config.overlay.windows).ToLowerInvariant() + " in " + $file)
        return
    }
    $config.overlay | Add-Member -NotePropertyName windows -NotePropertyValue $true
    [System.IO.File]::WriteAllText($file, ($config | ConvertTo-Json -Depth 20), $utf8)
    Say "Cards are on."
}

try {
    if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is missing. Install Node 20 or newer (winget install -e --id OpenJS.NodeJS.LTS), then open a new terminal." }
    if ($null -eq (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw "npm.cmd is missing. Reinstall Node, then open a new terminal." }
    Set-Location -LiteralPath $Root

    Invoke-Step 1 "Install dependencies (a few minutes the first time)" "npm.cmd" @("ci", "--no-fund", "--no-audit")
    Invoke-Step 2 "Build" "npm.cmd" @("run", "build")
    Invoke-Step 3 "Prepare the release files" "node" @("scripts\build-release.mjs", "--stage-only")
    Invoke-Step 4 "Package" "node" @("scripts\build-release-windows.mjs")
    $env:OSSEO_ARCHIVE = Join-Path $Root "release\osseo-win-x64.zip"
    Invoke-Step 5 "Install" "powershell.exe" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "install.ps1"), "-Force")

    if ($DryRun) { Say ""; Say "Dry run. Nothing was changed."; exit 0 }

    Say ""
    if (-not $NoCards) { Enable-Cards }

    Say ""
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & (Join-Path $env:LOCALAPPDATA "Osseo\bin\osseo.cmd") setup guide
    $guide = $LASTEXITCODE
    $ErrorActionPreference = $saved
    Say ""
    if ($guide -eq 0) { Say "Installed. Open a new terminal before you run osseo." }
    else { Say "Installed, but a check above failed. Read it before you rely on Osseo. Open a new terminal before you run osseo." }
    exit $guide
} catch {
    [Console]::Error.WriteLine("osseo install: " + $_.Exception.Message)
    exit 1
}
