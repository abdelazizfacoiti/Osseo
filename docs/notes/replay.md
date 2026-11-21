# Session replay

`osseo replay` turns one session of the audit log into a single local HTML page: a timeline (time, tool, redacted input summary, outcome, error code, duration), the approvals asked and given, and counts.

## What it holds

Summaries only. The audit log stores no screenshots and no typed text, and the replay stores none either. There are no before and after thumbnails; adding them would need a separate, opt-in capture store and is not built. The page is self-contained: inline CSS, no scripts, no network, a strict Content-Security-Policy, light and dark themes.

## Commands

- `osseo replay build [--session <id> | --task <id> | --last] [--out <file>]` builds the newest session by default and writes it to `~/.osseo/replays/`. The audit has no task field, so `--task` picks the session of the newest entry whose input summary contains the task id.
- `osseo replay list`
- `osseo replay open <id>` prints the path; it never launches a browser.
- `osseo replay delete <id> [--apply]` previews unless `--apply`.
- `--json` for scripts.

## Storage

Directory `~/.osseo/replays` (mode 0700), files `replay_<session>_<yyyymmddHHMM>.html` (mode 0600), written atomically. Ids match `^[A-Za-z0-9_]{1,80}$`. Each build prunes files older than 14 days, then the oldest until the total is under 50 MB.

## Outcomes

ok; waiting_approval (confirmation_required or approval required and not ok); blocked (grant denied, blocked tier, denied approval, or a block/policy/stop/takeover-style error code); otherwise failed. "Approval asked" is an entry with approval required, a generated preview or confirmation_required. "Approval given" is an accepted or rejected confirmation status or an approved or denied approval status.

## Automatic replay

Off by default. Set `"replay": { "onTaskFinish": true }` in `config.json` (no other key is accepted under `replay`). When an explicit task finishes or is cancelled, the server starts a detached child, `node <packages/osseo-cli/dist/index.js> replay build --task <taskId>`, with no shell, no output and `unref()`, so the task result never waits for it and never fails because of it. The child inherits the environment, so `OSSEO_HOME` is respected; `replay build` prunes old replays itself. If the CLI entry is missing, nothing is started. The server does not import the CLI (`packages/mcp-server/src/replay-trigger.ts`).

`--task` finds the session by matching the task id in audit input summaries; if none matches the command exits non-zero and writes nothing. A task build's id ends with the task id's first 8 characters (`replay_<session>_<yyyymmddHHMM>_<task>`), so two tasks of one session, or two builds in the same minute, write separate files.
