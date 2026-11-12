# AgentHost

[![ci](https://github.com/abdelazizfacoiti/AgentHost/actions/workflows/ci.yml/badge.svg)](https://github.com/abdelazizfacoiti/AgentHost/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-linux%20x86__64-lightgrey.svg)](docs/08_RELEASE_AND_OPERATIONS.md)
[![node](https://img.shields.io/badge/node-20%2B-green.svg)](docs/08_RELEASE_AND_OPERATIONS.md)

**AgentHost lets any AI agent use your real computer, and you can see and stop everything it does.**

It is a local server that speaks MCP, the protocol AI coding tools use to call
external tools. Connect it to your agent and the agent can open apps, click,
type, read files, run commands and drive a browser. A panel on your screen
shows each step as it happens, and you can pause or stop at any time.

<!-- demo.gif goes here -->
The demo will show an agent filling in a web form while the side dock lists
each action, then a delete request waiting on an approval card.

## What it does

- Controls the desktop: click, type, press keys, take screenshots, list and focus windows.
- Reads and writes files and runs shell commands, with protected system paths blocked.
- Drives a browser on its own Chrome profile, never your personal profile, using element references instead of screen pixels.
- Tracks work as tasks with a checklist, and saves repeatable plans as workflows with parameters.
- Runs saved workflows on a schedule through systemd user timers.
- Reports whether each click, key press or typed value changed the screen, so the agent does not guess.

## Why it is different

| | |
|---|---|
| Works with every MCP client | One server for Claude Code, Codex, Cursor, Copilot (VS Code and CLI), OpenCode and any other MCP client. Setup for these is built in. |
| Safety you can check | Sending, uploading, deleting, reading private data and payments need your approval of the exact action, usable once. Every call goes to a redacted audit log. Pause and Stop buttons are on screen and the agent cannot press them. |
| Guide mode | For apps the agent must not drive, `guide.show` draws labelled boxes on the places you should click. It never clicks. |

More detail on how it stays accurate and visible:

- The agent works from one numbered list: `see` returns the controls of a window as `[1] button "Save"`, and `click`, `type`, `scroll` and `drag` take a number. `type` reads the value back. The default tool list is 14 tools; the older tools still work by name (set `tools.profile` to `full` to list them).
- A dock at the side of the screen shows a live timeline of what the agent did, the current task with its checklist, and Pause and Stop. Nothing floats over the work area.
- Password, one-time-code and card fields are refused. Credential and security apps are blocked.
- When a task finishes or the agent asks a question, the agent's own window comes back to the front (Claude Code).

On the project's form benchmark, the browser route used over 50% fewer tool
calls and over 40% fewer result bytes than clicking pixels. These are the
benchmark's pass gate (`scripts/benchmark-form.mjs`). The test suite has over
550 tests.

## Quick start

You need Linux x86_64 with an X11 session (Wayland works through XWayland) and
Node 20 or newer. Install with one line:

```bash
curl -fsSL https://raw.githubusercontent.com/abdelazizfacoiti/AgentHost/main/scripts/install.sh | sh
```

This works once the repository is public. Until then, run the script from a
checkout with a local archive:
`AGENTHOST_ARCHIVE=/path/to/archive sh scripts/install.sh`.

The script checks the SHA-256, installs under `~/.local` without `sudo`, and
is safe to run again. Then run `agenthost doctor` and `agenthost setup`.
`doctor` checks your machine and lists missing desktop packages. Nothing runs
as root and nothing is installed silently.

**Windows (packaging added, untested).** You need 64-bit Windows and Node 20 or
newer. Download `install.ps1` from the repository, read it, then run it. Do not
pipe a web page into `iex`: you would run code you have not seen.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

It checks the SHA-256, installs under `%LOCALAPPDATA%\AgentHost` without
administrator rights, and adds `%LOCALAPPDATA%\AgentHost\bin` to your user
`Path`. Open a new terminal, then run `agenthost doctor`. `-DryRun` shows the
plan and changes nothing. See [docs/13_PLATFORMS.md](docs/13_PLATFORMS.md).

<details>
<summary>Manual install</summary>

Download a release archive, then:

```bash
sha256sum -c agenthost-v0.1.0-linux-x64.tar.gz.sha256
tar -xzf agenthost-v0.1.0-linux-x64.tar.gz
cd agenthost-v0.1.0-linux-x64
./bin/agenthost.mjs doctor
./bin/agenthost.mjs setup
```

</details>

Register the server with your agent. The command previews first; `--apply`
writes one entry and backs up an existing config:

```bash
agenthost integrations <client> add --apply   # opencode, claude, codex, copilot, copilot-cli, cursor
```

Reload the client so it starts AgentHost itself. Do not run `agenthost start`
by hand for a client session. Any other MCP client can use this entry:

```json
{ "mcpServers": { "agenthost": { "command": "agenthost", "args": ["start"] } } }
```

Then type this into the agent:

> Open Firefox and take a screenshot.

<details>
<summary>Build from a source checkout</summary>

```bash
git clone https://github.com/abdelazizfacoiti/AgentHost.git
cd AgentHost
npm ci
npm run build
npm run smoke:mcp
npm test
```

To keep experiments away from your install, use an isolated home:

```bash
export AGENTHOST_HOME="$PWD/.agenthost"
export AGENTHOST_CONFIG="$PWD/.agenthost/config.json"
npm run start:mcp
```

To install the portable skill that tells an assistant when to use AgentHost,
and register the server in one step:

```bash
npm run skill:install -- --target all
```

</details>

## How approvals work

When an action needs approval, the agent gets a preview of the exact action.
You can answer in any of these ways:

- In the chat: your MCP client asks you directly, and the agent cannot answer for you.
- On screen: an approval card that only a real mouse press can accept.
- In a terminal: `agenthost confirmations` lists pending requests, then `agenthost confirm <id>` or `agenthost deny <id>`.
- From a paired phone, if you set it up with `agenthost phone pair`.

Each approval covers one action and expires after 15 minutes.

## Platform support

| Platform | Status |
|---|---|
| Linux x86_64 (X11, Wayland through XWayland) | Supported |
| Windows | Packaging added, untested |
| macOS | Not started |

See [docs/13_PLATFORMS.md](docs/13_PLATFORMS.md) for what works in each session type.

## Documentation

- [Documentation index](docs/INDEX.md)
- [Product spec](docs/01_PRODUCT_SPEC.md)
- [System architecture](docs/02_SYSTEM_ARCHITECTURE.md)
- [MCP tools and adapters](docs/03_MCP_TOOLS_AND_ADAPTERS.md)
- [Security, permissions and logging](docs/04_SECURITY_PERMISSIONS_AND_LOGGING.md)
- [Release and operations](docs/08_RELEASE_AND_OPERATIONS.md)
- [Privacy and support](docs/11_PRIVACY_AND_SUPPORT.md)
- [Features and runtime guide](docs/12_V2_FEATURES_AND_RUNTIME_GUIDE.md)
- [Platforms](docs/13_PLATFORMS.md)
- [Agent skill](skills/agenthost/SKILL.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Status

AgentHost is early software with a single maintainer. It runs on Linux only
today. Windows work (desktop control and packaging) is in progress and has not
been tested on a real Windows machine. The tool names and
configuration may change between releases. Bug reports and run reports
(`agenthost task export <id>`) are welcome as issues.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
