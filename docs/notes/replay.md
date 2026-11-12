# Session replay

`agenthost replay` turns one session of the audit log into a single local HTML page: a timeline (time, tool, redacted input summary, outcome, error code, duration), the approvals asked and given, and counts.

## What it holds

Summaries only. The audit log stores no screenshots and no typed text, and the replay stores none either. There are no before and after thumbnails; adding them would need a separate, opt-in capture store and is not built. The page is self-contained: inline CSS, no scripts, no network, a strict Content-Security-Policy, light and dark themes.

## Commands

- `agenthost replay build [--session <id> | --task <id> | --last] [--out <file>]` builds the newest session by default and writes it to `~/.agenthost/replays/`. The audit has no task field, so `--task` picks the session of the newest entry whose input summary contains the task id.
- `agenthost replay list`
- `agenthost replay open <id>` prints the path; it never launches a browser.
- `agenthost replay delete <id> [--apply]` previews unless `--apply`.
- `--json` for scripts.

## Storage

Directory `~/.agenthost/replays` (mode 0700), files `replay_<session>_<yyyymmddHHMM>.html` (mode 0600), written atomically. Ids match `^[A-Za-z0-9_]{1,80}$`. Each build prunes files older than 14 days, then the oldest until the total is under 50 MB.

## Outcomes

ok; waiting_approval (confirmation_required or approval required and not ok); blocked (grant denied, blocked tier, denied approval, or a block/policy/stop/takeover-style error code); otherwise failed. "Approval asked" is an entry with approval required, a generated preview or confirmation_required. "Approval given" is an accepted or rejected confirmation status or an approved or denied approval status.
