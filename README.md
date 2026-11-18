# AgentHost

[![ci](https://github.com/abdelazizfacoiti/AgentHost/actions/workflows/ci.yml/badge.svg)](https://github.com/abdelazizfacoiti/AgentHost/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-20%2B-green.svg)](docs/08_RELEASE_AND_OPERATIONS.md)

**Let any AI agent use your computer, while you see every step and can stop it.**

AgentHost is a local MCP server. Connect it to Claude Code, Codex, Cursor, Copilot or OpenCode, and the agent can open apps, click, type, read files, run commands and drive a browser. The edge of your screen and a side panel show what it is doing, and anything risky waits for you.

![AgentHost asking before a delete: amber frame and an Approve, Always allow here or Deny card](docs/images/frame-4-approval.jpg)

## Quick start (Linux, 2 minutes)

Needs Linux x86_64 with X11 (or Wayland through XWayland) and Node 20+.

```bash
git clone https://github.com/abdelazizfacoiti/AgentHost.git
cd AgentHost
npm ci && npm run build && npm run release:build
AGENTHOST_ARCHIVE="$PWD/release/agenthost-linux-x64.tar.gz" sh scripts/install.sh
agenthost setup guide
```

`setup guide` checks your desktop packages, runs a self-test, finds your agent clients and prints the one command that connects each of them. For Claude Code it is:

```bash
claude mcp add agenthost --scope user -- agenthost start
```

Restart the client and try: *"Use AgentHost to open https://example.com and tell me what you see."*

<details>
<summary>Other clients</summary>

```bash
agenthost integrations <client> add --apply   # opencode, claude, codex, copilot, copilot-cli, cursor
```

Any MCP client can use:

```json
{ "mcpServers": { "agenthost": { "command": "agenthost", "args": ["start"] } } }
```

</details>

<details>
<summary>Claude Code auto mode blocks AgentHost calls</summary>

Allow the server once in `~/.claude/settings.json`. AgentHost still asks you before sends, uploads, deletes and payments.

```json
{ "permissions": { "allow": ["mcp__agenthost"] } }
```

In prompts, say "use AgentHost" rather than "don't use MCP": AgentHost is itself an MCP server.

</details>

## What you see

The screen edge shows the state at a glance, and the panel on the right keeps a timeline of every action with Pause and Stop.

| Edge | Meaning |
|---|---|
| Gray | on and idle (with `"overlay": { "frame": "always" }` in `~/.config/agenthost/config.json`) |
| Blue | an action is running |
| Green | done |
| Amber | waiting for your approval, or paused |
| Red | an action failed |

| Running | Done | Failed |
|---|---|---|
| ![Blue frame and a ring over the link about to be clicked](docs/images/frame-2-running.jpg) | ![Green frame and a Done card](docs/images/frame-3-done.jpg) | ![Red frame and a Failed card](docs/images/frame-5-error.jpg) |

## What it does

- **Sees and acts by number.** `see` lists a window's controls as `[1] button "Save"`, and `click`, `type`, `key`, `scroll` take the number. Typed values are read back, and every action reports whether the screen changed.
- **Picks the best route.** Browser pages and accessibility trees come before screenshots and pixel clicks.
- **Drives a browser** on its own Chrome profile, never yours.
- **Files and shell**, with protected system paths blocked.
- **Tasks and workflows.** Save steps as workflows and run them on a schedule.
- **Guide mode.** For apps the agent must not drive, it shows you where to click instead.

## Safety

- Sends, uploads, deletes, payments and private-data reads need your approval of the exact action, once, for 15 minutes.
- Approve in your client's chat, on the on-screen card (only a real mouse press counts) or with `agenthost confirm <id>`.
- Password, one-time-code and card fields are refused. Credential and security apps are blocked.
- Pause and Stop are always on screen, and the agent cannot press them.
- Every call is written to a redacted audit log. Screenshots and typed text are never logged.
- Rules live in `~/.agenthost/policy.toml` (`agenthost policy`).

## Platforms

| Platform | Status |
|---|---|
| Linux x86_64 (X11, Wayland through XWayland) | Supported |
| Windows | In progress: tools work, on-screen cards only, not yet release-tested |
| macOS | Not started |

## More

[Docs index](docs/INDEX.md) · [Tools](docs/03_MCP_TOOLS_AND_ADAPTERS.md) · [Security](docs/04_SECURITY_PERMISSIONS_AND_LOGGING.md) · [Platforms](docs/13_PLATFORMS.md) · [Agent skill](skills/agenthost/SKILL.md) · [Contributing](CONTRIBUTING.md)

Early software with a single maintainer; tool names and configuration may change. Apache-2.0, see [LICENSE](LICENSE).
