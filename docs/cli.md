# The `osseo` command

`osseo <command> --help` prints the exact usage of each command. Commands that change something preview by default
and need `--apply`.

## Setup and health

| Command | What it does |
|---|---|
| `osseo setup guide` | First-run path: data folder, missing packages, self-test, agent clients to connect. |
| `osseo setup deps [--apply]` | Check, then install, the desktop packages Osseo needs. |
| `osseo selftest [--json] [--viewer]` | Prove this install works in a few seconds. |
| `osseo doctor [--json]` | What is installed, running and missing. |
| `osseo config show \| validate \| path` | Inspect the settings file. |
| `osseo integrations <client> add \| status \| remove [--apply]` | Connect `claude`, `codex`, `cursor`, `opencode`, `copilot` or `copilot-cli`. `--allow-tools read\|all` (Claude Code) skips its own prompts for Osseo tools. |
| `osseo update --archive <file> [--apply]` / `--rollback` | Update from a release archive (checksum verified), or go back. |
| `osseo uninstall [--yes] [--remove-data]` | Remove Osseo; data stays unless asked. |

## Control

| Command | What it does |
|---|---|
| `osseo agent status \| pause \| stop \| takeover-begin` | The run state. |
| `osseo agent resume --stop \| --pause \| --takeover` | Clear one of them (you only; the agent cannot). |
| `osseo confirmations` | Pending approvals. |
| `osseo confirm <id> [--always]` / `osseo deny <id>` | Approve or refuse one exact action; `--always` also writes a rule. |
| `osseo policy list \| add \| remove` | Your approval rules (`~/.osseo/policy.toml`). |
| `osseo shortcut install [--binding <keys>] [--apply]` | GNOME keyboard shortcut for Stop (default Ctrl+Shift+Alt+Esc). |
| `osseo tray start \| stop \| status` | Tray icon with the state and Stop, Pause, Resume. |
| `osseo viewer start \| stop \| status` | Live view of the background display with Pause, Resume and Stop. |
| `osseo host status \| start \| stop \| restart` | The per-user host that all sessions share. |

## After a run

| Command | What it does |
|---|---|
| `osseo replay build [--last \| --session <id> \| --task <id>]` | One HTML page of a session: what was done, approved and refused. |
| `osseo journal show \| save <name> [--apply]` | Turn the agent's steps into a saved workflow. |
| `osseo workflow list \| show \| run \| delete` | Saved, parameterised plans (`--param k=v`). |
| `osseo schedule list \| add \| remove` | Run a workflow daily, on weekdays or every N minutes. |
| `osseo task watch <id> [--follow]` / `task export <id>` | Follow a task, or export a redacted report. |
| `osseo failures [summary \| show \| clear]` | Unexpected tool failures, grouped. |
| `osseo overlay status \| hide` | Whether the panel and cards show; hide them. |

## Running the server

`osseo start` is what agent clients run. You do not start it yourself.
