# Linux Release and Operations

Osseo ships as a local Linux x86_64 archive with an `osseo` CLI. The
root npm package remains private; no npm publication is promised. The runtime
is provider-agnostic and uses MCP over stdio.

## Supported boundary

- Ubuntu/Debian-compatible Linux, x86_64 first.
- Node.js 20+; Python 3 and GTK3/PyGObject are needed for the visible overlay.
- X11 is the verified visible-overlay path. Wayland reports limited or
  unavailable global-overlay features.
- The live MCP surface is the 70 tools and 3 resources documented in
  `docs/03_MCP_TOOLS_AND_ADAPTERS.md`.
- This tree
  registers no browser bridge, speech, scheduler, Forge, or Control Room
  surface.

## Install

The supported public artifact is the GitHub source tree and Linux x86_64
archive/CLI.

```bash
npm run build
npm run release:build
npm run release:scan
npm run release:verify
(cd release && sha256sum -c osseo-v0.1.0-linux-x64.tar.gz.sha256)
npm run release:install -- release/osseo-v0.1.0-linux-x64.tar.gz
```

When consuming a downloaded archive directly, verify its sidecar checksum,
extract it, and run `./bin/osseo.mjs doctor` from the extracted directory.
The wrapper is self-contained and does not require `sudo`.

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/abdelazizfacoiti/Osseo/main/scripts/install.sh | sh
```

`scripts/install.sh` is POSIX `sh`. It needs Linux x86_64, Node 20 or newer,
`tar`, `sha256sum`, and `curl` or `wget`. It takes the archive from
`OSSEO_ARCHIVE` (a local path), then `OSSEO_ARCHIVE_URL`, then the
latest GitHub release asset `osseo-linux-x64.tar.gz`. It always checks the
SHA-256 against the `.sha256` file next to the archive and stops when it is
missing or wrong. It unpacks in a temporary directory, runs the release's own
`update --archive --apply`, and writes the same `~/.local/bin/osseo`
launcher as `release:install`. A second run with the same version reports
that it is already installed. `--dry-run` prints the plan and changes nothing.

### Windows install (untested)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-DryRun] [-Help]
```

`scripts/install.ps1` runs on Windows PowerShell 5.1 or newer. It needs 64-bit
Windows and Node 20 or newer, and no administrator rights. The archive comes
from `OSSEO_ARCHIVE` (a local `.zip`), then `OSSEO_ARCHIVE_URL`, then
the latest GitHub release asset `osseo-win-x64.zip`. The SHA-256 is always
checked against the `.sha256` file next to the archive. The script unpacks to a
short temporary folder (removed in `finally`), then runs the release's own
`update --archive <zip> --apply`, which reads the zip with Node only and
switches the release.

Install writes only Osseo-owned locations:

```text
%LOCALAPPDATA%\Osseo\releases\<version>\   the unpacked release
%LOCALAPPDATA%\Osseo\current                 junction to the active release
%LOCALAPPDATA%\Osseo\current.previous        junction to the one before (rollback)
%LOCALAPPDATA%\Osseo\bin\osseo.cmd       launcher for cmd and PowerShell
%LOCALAPPDATA%\Osseo\bin\osseo           launcher for Git Bash
%APPDATA%\osseo\config.json                  public config
%USERPROFILE%\.osseo\                         runtime data (as on Linux)
```

`current` is a directory junction: it needs no administrator rights, and it can
be replaced while programs run from the old release, which renaming a folder
cannot do. The switch is two steps (remove the old link, create the new one), so
it is not atomic; a failure puts the old link back. Only `current` and
`current.previous` releases are kept. The script adds `bin` to the user `Path`
(registry `HKCU\Environment`, never the machine `Path`) only when it is missing;
open a new terminal afterwards. A second run with the same version changes
nothing. `osseo uninstall --yes` removes the install folder but not the
`Path` entry.

The Windows archive is built on Linux after the Linux one, with Node only:

```bash
npm run build && npm run release:build && npm run release:build:windows
```

It writes `release/osseo-v<version>-win-x64.zip`, its `.sha256`, and the
fixed-name copy `osseo-win-x64.zip` (+ `.sha256`) that the installer fetches
from the latest release. It holds the packages including `os-windows`, no Python
overlay files and no native binaries (the build fails if one appears), and a
`bin\osseo.mjs` entry. Workspace links under `node_modules/@osseo` are
copied as real folders because a zip cannot carry links. `release/SHA256SUMS`
still lists only the Linux archive.

Scheduled workflows on Windows use Task Scheduler (`schtasks.exe`), one task
`Osseo\wf-<name>` per workflow, per user, without elevation. The task runs
only while you are logged on. Preview by default; `--apply` writes.

Install writes only Osseo-owned locations (Linux):

```text
~/.local/share/osseo/
~/.local/bin/osseo
~/.config/osseo/config.json
~/.osseo/
```

No root privileges, package installation, system service, or hidden browser
installation is used.

## CLI

```text
osseo version
osseo doctor [--json]
osseo setup [--resume]
osseo start
osseo stop
osseo status
osseo confirmations [list] / confirm <tokenId> / deny <tokenId>
osseo agent status / pause / stop / takeover-begin / resume --stop|--takeover|--pause
osseo task [list|status|pause|resume|stop|approve]
osseo task watch <id> [--follow] [--notify] [--overlay]
osseo task export <id> [--format md|html] [--out <path>]
osseo capabilities
osseo permissions
osseo overlay hide [--orphans] / overlay status
osseo integrations <client> add|status|remove [--apply] [--project DIR]
osseo config validate|show
osseo update --archive <archive> [--sha256 <64-hex-digest>] [--apply]
osseo update --rollback
osseo uninstall [--dry-run] [--remove-data]
```

`osseo start` runs in the foreground. There is no daemon, cron, systemd
unit, restart loop, or hidden background execution. Output never contains
secrets, private file content, screenshots, OCR text, or raw private paths.

## MCP client integration

`osseo integrations <client> add` previews one Osseo entry; `--apply`
is the only write path. Existing servers and unrelated settings remain
untouched, and an existing file is backed up before changes. Supported clients:

| Client | Config |
|---|---|
| `opencode` | `~/.config/opencode/opencode.json[c]` under `mcp` |
| `claude` | `~/.claude.json` under `mcpServers` |
| `codex` | `~/.codex/config.toml` under `[mcp_servers.osseo]` |
| `copilot` | `<project>/.vscode/mcp.json` under `servers` |
| `copilot-cli` | `~/.copilot/mcp-config.json` under `mcpServers` |
| `cursor` | `<project>/.cursor/mcp.json` under `mcpServers` |

The entry uses the installed `osseo start`, never a repository path.
`--project DIR` selects the project for Copilot and Cursor. `XDG_CONFIG_HOME`,
`CODEX_HOME`, `COPILOT_HOME`, and `CLAUDE_CONFIG_DIR` override the default user
config roots.

On Windows the same files are used, relative to `%USERPROFILE%`, and the entry
starts the server as `cmd /c osseo start` (`osseo` is a `.cmd` file, and
clients that start a program without a shell cannot run a `.cmd` by its bare
name). Codex's `notify` uses the same `cmd /c` form. Claude Code's attention
hooks use plain `osseo attention ...` calls with no shell syntax; the
Linux `[ -f ... ] && ... || true` guard is not written on Windows.
Invalid JSON/TOML, ambiguous TOML, and unsupported layouts are rejected
without writing.
A JSONC write may normalize formatting and drop comments; the backup retains
the original text. After `--apply`, reload or restart the client so it spawns
Osseo. Running `osseo start` manually does not attach tools to a client
session; it is the stdio server the client owns.

`npm run skill:install -- --target all` installs the skill text and applies the
same MCP registration for all six targets. Use `--no-mcp` for skill text only.

## Setup and doctor

`osseo setup` is local, resumable, idempotent, and optional-step aware.

`osseo doctor` checks runtime versions, config, permissions, MCP
availability, X11, GTK/PyGObject import support, OCR availability, storage, and
stale process state. JSON output uses stable status fields and redacted path
labels.

Supported environment overrides are `OSSEO_HOME`, `OSSEO_CONFIG`, `OSSEO_LOG_FILE`, and
`OSSEO_OVERLAY_MODE`. The legacy `OSSEO_PROFILE` variable is ignored.
Values are schema-validated; environment overrides do not bypass grants,
confirmation, redaction, or stop/takeover gates.

## Lifecycle and recovery

MCP operation is foreground. `osseo start` runs the server in the
foreground, and `osseo stop` writes the runtime stop flag. No daemon, cron,
systemd unit, restart loop, or hidden persistence exists.

Updates require an operator-provided archive, checksum verification, preflight,
backup, health check, and rollback on failure. Uninstall removes only
Osseo-owned installation files by default and leaves runtime data and
system dependencies intact.

## Release contents and scanning

The archive contains compiled runtime, production dependencies, renderer
assets, version manifest, documentation, legal files, and per-file hashes. The
release directory also contains archive `SHA256SUMS` sidecars. The project is
Apache-2.0 licensed; `LICENSE`, `NOTICE`, and generated
`THIRD_PARTY_NOTICES` are copied and verified. The artifact excludes runtime
state, logs, screenshots, OCR/page text, confirmations, credentials, caches,
temporary files, development tests/maps, absolute checkout links, and dangling
development symlinks.

Public repository governance files (`CODE_OF_CONDUCT.md`, `SECURITY.md`, and
`SUPPORT.md`) are copied into the archive. The root npm package remains
private; the supported public artifact is the Linux archive and CLI.

`release:scan` fails on credential-like material, token formats, current-user
absolute paths, private media/log artifacts, oversized files, or unsafe release
contents. `release:verify` validates manifest fingerprints.

## Security guarantees

Packaging does not alter Osseo safety boundaries: no public bridge, no
secret extraction, no CAPTCHA/MFA/login/payment bypass, no silent
send/submit/upload/delete/pay/buy, no sudo, no arbitrary generated code, and no
autonomous background operation. Every MCP tool passes through schema
validation, stop/takeover gating, preview, execution, and redacted audit
logging. Routine local actions execute directly; consequential effects add an
exact preview and single-use confirmation token. `osseo agent
stop` writes the runtime flag so state-changing calls halt even if the model
does not cooperate. Human takeover pauses agent action until the operator
resumes control.
