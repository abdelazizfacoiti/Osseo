# Osseo installer for Windows (x64). PowerShell 5.1 or newer. ASCII only.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-Help]
#
# Download the script first, read it, then run it. Do not pipe a web page into iex.
#
# Archive source, first match wins:
#   OSSEO_ARCHIVE      local .zip path (the .sha256 file sits next to it)
#   OSSEO_ARCHIVE_URL  archive URL (the .sha256 file is at the same URL plus .sha256)
#   otherwise              latest GitHub release of abdelazizfacoiti/Osseo, asset osseo-win-x64.zip
#
# Installs under %LOCALAPPDATA%\Osseo and adds %LOCALAPPDATA%\Osseo\bin to the USER Path.
# It needs no administrator rights and does not change the execution policy or the machine Path.
# `current` is a directory junction (created by the release's own updater): a junction needs no
# administrator rights, and it can be replaced while programs still run from the old release,
# which a folder rename cannot.

param(
    [switch]$DryRun,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$Repo = "abdelazizfacoiti/Osseo"
$Asset = "osseo-win-x64.zip"

function Say([string]$Text) { Write-Host $Text }
function Fail([string]$Text) { throw $Text }

function Show-Usage {
    Say "Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-Help]"
    Say "Installs Osseo into %LOCALAPPDATA%\Osseo and writes %LOCALAPPDATA%\Osseo\bin\osseo.cmd."
    Say "Environment: OSSEO_ARCHIVE (local .zip path), OSSEO_ARCHIVE_URL (archive URL)."
    Say "The SHA-256 is always checked against the .sha256 file next to the archive."
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Read-ExpectedSha256([string]$Path) {
    $line = Get-Content -LiteralPath $Path -TotalCount 1
    if ($null -eq $line) { return $null }
    $m = [regex]::Match([string]$line, '^\s*([0-9a-fA-F]{64})(\s.*)?$')
    if (-not $m.Success) { return $null }
    return $m.Groups[1].Value.ToLowerInvariant()
}

function Get-Download([string]$Url, [string]$Target) {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
    $saved = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target
    } finally {
        $ProgressPreference = $saved
    }
}

function Test-SafeEntryName([string]$Name) {
    if ([string]::IsNullOrEmpty($Name)) { return $false }
    if ($Name.Contains("\") -or $Name.Contains(":") -or $Name.StartsWith("/")) { return $false }
    foreach ($part in $Name.Split("/")) {
        if ($part -eq "..") { return $false }
    }
    return $true
}

function Write-Launchers([string]$Bin, [string]$LocalAppData) {
    if ($LocalAppData.Contains('"') -or $LocalAppData.Contains('$') -or $LocalAppData.Contains('`')) {
        Fail "LOCALAPPDATA contains a quote, dollar sign or backtick."
    }
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    # osseo.cmd: for cmd.exe and PowerShell.
    $cmd = "@echo off`r`n" +
        "rem Osseo launcher. Written by scripts\install.ps1.`r`n" +
        "node `"%LOCALAPPDATA%\Osseo\current\bin\osseo.mjs`" %*`r`n"
    [System.IO.File]::WriteAllText((Join-Path $Bin "osseo.cmd"), $cmd, $utf8)
    # osseo (no extension): for Git Bash, which does not run .cmd files by bare name.
    $root = $LocalAppData.Replace("\", "/").TrimEnd("/")
    $sh = "#!/bin/sh`n" + "exec node `"$root/Osseo/current/bin/osseo.mjs`" `"`$@`"`n"
    [System.IO.File]::WriteAllText((Join-Path $Bin "osseo"), $sh, $utf8)
}

# Adds $Bin to the USER Path when it is missing. Returns $true when it changed the Path.
function Add-UserPath([string]$Bin) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    if ($null -eq $key) { Fail "cannot open the user environment in the registry." }
    try {
        $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try { $kind = $key.GetValueKind("Path") } catch { }
        $want = $Bin.TrimEnd("\").ToLowerInvariant()
        foreach ($entry in $raw.Split(";")) {
            if ($entry.Trim() -eq "") { continue }
            $plain = [Environment]::ExpandEnvironmentVariables($entry.Trim()).TrimEnd("\").ToLowerInvariant()
            if ($plain -eq $want) { return $false }
        }
        if ($raw -eq "" -or $raw.EndsWith(";")) { $new = $raw + $Bin } else { $new = $raw + ";" + $Bin }
        $key.SetValue("Path", $new, $kind)
    } finally {
        $key.Close()
    }
    # Ask running programs to reread the environment (best effort): changing any user variable broadcasts it.
    try {
        [Environment]::SetEnvironmentVariable("OSSEO_PATH_REFRESH", "1", "User")
        [Environment]::SetEnvironmentVariable("OSSEO_PATH_REFRESH", $null, "User")
    } catch { }
    return $true
}

function Install-Osseo {
    if ($Help) { Show-Usage; return }

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { Fail "Windows is required." }
    $arch = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($arch)) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne "AMD64") { Fail "x64 (AMD64) is required (found $arch)." }
    if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node is missing. Install Node 20 or newer." }
    $major = 0
    $nodeMajor = (& node -p "process.versions.node.split('.')[0]" 2>$null)
    if (-not [int]::TryParse([string]$nodeMajor, [ref]$major)) { $major = 0 }
    if ($major -lt 20) { Fail ("Node 20 or newer is required (found " + (& node -v 2>$null) + ").") }
    $local = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($local) -or -not (Test-Path -LiteralPath $local -PathType Container)) { Fail "LOCALAPPDATA is not set to a folder." }

    if (-not [string]::IsNullOrEmpty($env:OSSEO_ARCHIVE)) {
        $sourceKind = "file"
        $sourceRef = $env:OSSEO_ARCHIVE
        if (-not (Test-Path -LiteralPath $sourceRef -PathType Leaf)) { Fail "OSSEO_ARCHIVE not found: $sourceRef" }
        if (-not (Test-Path -LiteralPath ($sourceRef + ".sha256") -PathType Leaf)) { Fail ("checksum file missing: " + $sourceRef + ".sha256") }
    } elseif (-not [string]::IsNullOrEmpty($env:OSSEO_ARCHIVE_URL)) {
        $sourceKind = "url"
        $sourceRef = $env:OSSEO_ARCHIVE_URL
    } else {
        $sourceKind = "url"
        $sourceRef = "https://github.com/$Repo/releases/latest/download/$Asset"
    }

    $share = Join-Path $local "Osseo"
    $bin = Join-Path $share "bin"
    $current = Join-Path $share "current"

    if ($DryRun) {
        Say "Dry run. Nothing will be changed."
        Say "Archive: $sourceRef"
        Say ("Check SHA-256 against: " + $sourceRef + ".sha256")
        Say "Install to: $current"
        Say ("Write launchers: " + (Join-Path $bin "osseo.cmd") + " and " + (Join-Path $bin "osseo"))
        Say "Add to the user Path when missing: $bin"
        return
    }

    # A short folder name keeps the unpacked paths under the 260-character limit of older tools.
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("ah-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $archive = Join-Path $work $Asset
        if ($sourceKind -eq "file") {
            Copy-Item -LiteralPath $sourceRef -Destination $archive
            Copy-Item -LiteralPath ($sourceRef + ".sha256") -Destination ($archive + ".sha256")
        } else {
            try { Get-Download $sourceRef $archive } catch { Fail "download failed: $sourceRef" }
            try { Get-Download ($sourceRef + ".sha256") ($archive + ".sha256") } catch { Fail ("checksum file missing: " + $sourceRef + ".sha256") }
        }

        $expected = Read-ExpectedSha256 ($archive + ".sha256")
        if ($null -eq $expected) { Fail "checksum file is not a SHA-256 digest." }
        $actual = Get-FileSha256 $archive
        if ($expected -ne $actual) { Fail "SHA-256 mismatch. Nothing was installed." }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $tops = @{}
        $zip = $null
        try {
            $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
            foreach ($entry in $zip.Entries) {
                if (-not (Test-SafeEntryName $entry.FullName)) { Fail "the archive has unsafe paths." }
                $tops[$entry.FullName.Split("/")[0]] = $true
            }
        } catch {
            if ($_.Exception.Message -like "the archive*") { throw }
            Fail "the archive cannot be read."
        } finally {
            if ($null -ne $zip) { $zip.Dispose() }
        }
        if ($tops.Count -ne 1) { Fail "unexpected archive layout." }
        $topName = @($tops.Keys)[0]
        $unpacked = Join-Path $work "x"
        [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $unpacked)
        $top = Join-Path $unpacked $topName
        $manifestFile = Join-Path $top "version.json"
        if (-not ((Test-Path -LiteralPath $manifestFile -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $top "bin\osseo.mjs") -PathType Leaf))) { Fail "the archive is not an Osseo release." }
        $version = [string](Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json).version
        if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { Fail "cannot read the release version." }

        $installed = ""
        $installedManifest = Join-Path $current "version.json"
        if (Test-Path -LiteralPath $installedManifest -PathType Leaf) {
            try { $installed = [string](Get-Content -Raw -LiteralPath $installedManifest | ConvertFrom-Json).version } catch { $installed = "" }
        }
        if (($installed -eq $version) -and (Test-Path -LiteralPath (Join-Path $bin "osseo.cmd") -PathType Leaf)) {
            Say "Osseo $version is already installed in $current."
        } else {
            # The release's own updater checks the archive again, unpacks it to releases\<version>,
            # points the `current` junction at it and keeps `current.previous`.
            $saved = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                $log = & node (Join-Path $top "bin\osseo.mjs") update --archive $archive --sha256 $actual --apply 2>&1 | Out-String
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $saved
            }
            if ($code -ne 0) { [Console]::Error.WriteLine($log); Fail "the release updater failed." }
            if (-not (Test-Path -LiteralPath (Join-Path $current "bin\osseo.mjs") -PathType Leaf)) { Fail "install did not produce $current." }
            Write-Launchers $bin $local
            if ($installed -ne "") { Say "Upgraded Osseo $installed to $version in $current." } else { Say "Installed Osseo $version in $current." }
        }

        if (Add-UserPath $bin) {
            Say "Added $bin to your user Path. Open a new terminal before you run osseo."
        } else {
            Say "$bin is already on your user Path."
        }
        Say "Next: osseo integrations <client> add --apply   (opencode, claude, codex, copilot, copilot-cli, cursor)"
    } finally {
        try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
}

try {
    Install-Osseo
} catch {
    [Console]::Error.WriteLine("osseo install: " + $_.Exception.Message)
    exit 1
}
