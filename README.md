# Osseo

[![ci](https://github.com/abdelazizfacoiti/Osseo/actions/workflows/ci.yml/badge.svg)](https://github.com/abdelazizfacoiti/Osseo/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-20%2B-green.svg)](docs/getting-started.md)

**Let any AI agent use your computer, while you see every step and can stop it.**

Osseo is a local MCP server. Connect it to Claude Code, Codex, Cursor, Copilot or OpenCode, and the agent can open apps, click, type, read files, run commands and drive a browser. The edge of your screen and a side panel show what it is doing, and anything risky waits for you.

**Demo (2 minutes, no sound):** one prompt, and the agent models a chair in Blender through its GUI, renders it and lists it on Shopify. No Blender MCP, no scripts. Parts are sped up.

https://github.com/user-attachments/assets/96a10897-2c56-46b3-930a-32d65f3acf75

![Osseo asking before a delete: amber frame and an Approve, Always allow here or Deny card](docs/images/frame-4-approval.jpg)

## Quick start (Linux, 2 minutes)

Needs Linux x86_64 with X11 (or Wayland through XWayland) and Node 20+. On Windows, use the [Windows steps](#quick-start-windows-experimental).

```bash
git clone https://github.com/abdelazizfacoiti/Osseo.git
cd Osseo
npm ci && npm run build && npm run release:build
OSSEO_ARCHIVE="$PWD/release/osseo-linux-x64.tar.gz" sh scripts/install.sh
osseo setup guide
```

`setup guide` checks your desktop packages, runs a self-test, finds your agent clients and prints the one command that connects each of them. For Claude Code it is:

```bash
claude mcp add osseo --scope user -- osseo start
```

Restart the client and try: *"Use Osseo to open https://example.com and tell me what you see."*

<details>
<summary>Other clients</summary>

```bash
osseo integrations <client> add --apply   # opencode, claude, codex, copilot, copilot-cli, cursor
```

Any MCP client can use:

```json
{ "mcpServers": { "osseo": { "command": "osseo", "args": ["start"] } } }
```

</details>

<details>
<summary>Claude Code auto mode blocks Osseo calls</summary>

Let Claude Code run Osseo's tools without asking again. Osseo itself still asks you before sends, uploads, deletes and payments.

```bash
osseo integrations claude add --allow-tools all --apply   # or: read (status, windows, see, wait)
```

In prompts, say "use Osseo" rather than "don't use MCP": Osseo is itself an MCP server.

</details>

## Quick start (Windows, experimental)

Windows support is still in progress: expect rough edges. You need Windows 10 or 11 (x64), Node 20+, Git, and Chrome or Edge for the agent's browser. Tests so far ran on Windows 11 only. There is no Windows download yet, so you build it. In PowerShell:

```powershell
git clone https://github.com/abdelazizfacoiti/Osseo.git
cd Osseo
npm ci
npm run build
node scripts/build-release.mjs --stage-only
node scripts/build-release-windows.mjs
$env:OSSEO_ARCHIVE = "$PWD\release\osseo-win-x64.zip"
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

It installs to `%LOCALAPPDATA%\Osseo` without administrator rights. **Open a new terminal**, then:

**1. Turn on the on-screen cards.** They are off by default on Windows, and without them there is no on-screen Pause, Stop or Approve button. Run `osseo setup guide` once, then `osseo config path` to find `config.json`, and add `"windows": true` under `"overlay"`:

```json
{ "overlay": { "windows": true } }
```

Keep the other settings already in the file. A real mouse click on the card's **Stop** button is not yet confirmed on the current Windows build, so keep `osseo agent stop` (below) ready.

**2. Connect your client**, then restart it:

```powershell
osseo integrations claude add --apply   # or: codex, cursor, opencode, copilot, copilot-cli
```

Connecting a client from an installed Windows build is not tested yet, so please [report](https://github.com/abdelazizfacoiti/Osseo/issues) what fails. To stop the agent from a terminal, run `osseo agent stop`; `osseo agent resume --stop` lets it continue.

Not on Windows yet: reading text from the screen (OCR), the colored screen edge and the ring around click targets. See [platforms](docs/platforms.md).

## What you see

The screen edge shows the state at a glance, and the panel on the right keeps a timeline of every action with Pause and Stop. Several agent sessions share one panel through a small local host, so they never fight over the screen.

| Edge | Meaning |
|---|---|
| Gray | on and idle (with `"overlay": { "frame": "always" }` in `~/.config/osseo/config.json`); it fades after 2 minutes without an action (`"frameIdleMs"`, 0 keeps it) |
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
- **Fast.** On our benchmark a verified key takes 0.4 s and reading a window takes 50 ms with an accessibility tree. `steps` and `key {sequence}` batch routine work into one call ([measurements](docs/notes/speed-plan.md)).
- **Drives a browser** on its own Chrome profile, never yours.
- **Files and shell**, with protected system paths blocked.
- **Tasks and workflows.** Save steps as workflows and run them on a schedule.
- **Guide mode.** For apps the agent must not drive, it shows you where to click instead.

## Safety

- Sends, uploads, deletes, payments and private-data reads need your approval of the exact action, once, for 15 minutes.
- Approve in your client's chat, on the on-screen card (only a real mouse press counts) or with `osseo confirm <id>`.
- Password, one-time-code and card fields are refused. Credential and security apps are blocked.
- Pause and Stop are always on screen, and the agent cannot press them.
- Every call is written to a redacted audit log. Screenshots and typed text are never logged.
- Rules live in `~/.osseo/policy.toml` (`osseo policy`).

## Platforms

See [platforms](docs/platforms.md) for detail.

| Platform | Status |
|---|---|
| Linux x86_64 (X11, Wayland through XWayland) | Supported |
| Windows 10/11 | In progress, build from source ([steps](#quick-start-windows-experimental)): desktop tools pass their checks on Windows 11, cards are opt-in |
| macOS | Not started |

## More

[Docs](docs/INDEX.md) · [Getting started](docs/getting-started.md) · [How it works](docs/how-it-works.md) · [Safety](docs/safety.md) · [Tools](docs/tools.md) · [Platforms](docs/platforms.md) · [Agent skill](skills/osseo/SKILL.md) · [Contributing](CONTRIBUTING.md)

Early software with a single maintainer; tool names and configuration may change. Apache-2.0, see [LICENSE](LICENSE).

Osseo is an independent project, not affiliated with or endorsed by Anthropic, OpenAI, GitHub, Microsoft or Cursor. Product names are trademarks of their owners and are used only to say which clients it works with.
