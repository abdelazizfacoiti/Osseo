# Getting started

Osseo runs on Linux x86_64 with X11 (Wayland sessions work through XWayland) and Node 20 or newer.

## Install

From a release:

```bash
curl -fsSL https://raw.githubusercontent.com/abdelazizfacoiti/Osseo/main/scripts/install.sh | sh
```

From a clone:

```bash
git clone https://github.com/abdelazizfacoiti/Osseo.git && cd Osseo
npm ci && npm run build && npm run release:build
OSSEO_ARCHIVE="$PWD/release/osseo-linux-x64.tar.gz" sh scripts/install.sh
```

The installer checks the archive's SHA-256, puts the release in `~/.local/share/osseo/current` and the `osseo`
command in `~/.local/bin`.

## First run

```bash
osseo setup guide
```

It creates the data folder, lists any missing desktop packages (with the one command that installs them), runs the
self-test, finds your agent clients and prints the command that connects each one. It installs nothing on its own.

`osseo setup deps --apply` installs the missing packages (it asks for your password). `osseo selftest` proves the
install works in a few seconds: it fills a local form in a headless browser by number.

## Connect an agent

```bash
osseo integrations claude add --apply     # also: codex, cursor, opencode, copilot, copilot-cli
```

Or add it to any MCP client by hand:

```json
{ "mcpServers": { "osseo": { "command": "osseo", "args": ["start"] } } }
```

Restart the client, then try: *"Use Osseo to open https://example.com and tell me what you see."*

With Claude Code in auto mode, `osseo integrations claude add --allow-tools all --apply` lets it call Osseo's tools
without asking again. Osseo itself still asks you before sends, uploads, deletes and payments.

## Several sessions

`osseo start` connects every session to one small local host, so all agents share one side panel and one edge frame
and never fight over the screen. `OSSEO_HOST=0` in a client's environment opts that session out.

## Update, roll back, uninstall

```bash
osseo update --archive <osseo-linux-x64.tar.gz> --apply   # checks the SHA-256 first
osseo host stop                                           # the next session starts on the new build
osseo update --rollback --apply
osseo uninstall --yes                 # keeps your data; add --remove-data to delete ~/.osseo too
```

## Where things live

| Path | What |
|---|---|
| `~/.config/osseo/config.json` | Settings (`osseo config path` shows which file is read) |
| `~/.osseo/policy.toml` | Your rules for what needs approval |
| `~/.osseo/logs/osseo.jsonl` | Redacted audit log of every call |
| `~/.osseo/logs/failures.jsonl` | Unexpected tool failures (`osseo failures`) |
| `~/.osseo/replays/` | Session replay pages (`osseo replay`) |
| `~/.osseo/browser/profiles/agent/` | The agent's own browser profile, never yours |

Installs from before the rename keep using `~/.agenthost` and `~/.config/agenthost` until the new folders exist.

## When something is wrong

```bash
osseo doctor          # what is installed, running and missing
osseo overlay status  # whether the side panel and cards are showing
osseo failures        # recent unexpected failures, grouped
osseo agent status    # stopped, paused or in a takeover?
```
