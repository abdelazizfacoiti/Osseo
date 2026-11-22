# Safety

Osseo exists so an agent can use a real computer while you keep control. Every tool call goes through the same path:

```text
schema check → Stop / pause / takeover gate → preview → approval (when consequential) → action → redacted audit log
```

## What needs your approval

By default, routine actions (looking, typing into a form, clicking a tab) run directly, and these ask first:

- **send** (messages, emails, form submissions that send something),
- **upload**,
- **delete**,
- **pay**,
- reading private data, and anything rated high risk.

The agent gets a `confirmation_required` result with a preview of the exact action. You approve it once, for that exact
action, in one of three places:

- the approval prompt in your agent client's chat,
- the card on screen (only a real mouse press counts),
- the terminal: `osseo confirmations` lists them, `osseo confirm <id>` approves, `osseo deny <id>` refuses.

An approval is single-use, bound to the tool, its exact arguments and target, and expires after 15 minutes.
**Always allow here** (in chat, on the card, or `osseo confirm <id> --always`) approves once and writes a rule so the
same kind of action on the same site or app no longer asks.

## Your rules: `~/.osseo/policy.toml`

```toml
[[rule]]
action = "send"          # any, send, upload, delete, pay, navigate, type, click
site = "mail.example.com" # optional; or app = "Slack"
decision = "ask"         # allow (no prompt), ask (prompt each time), never (refuse)
note = "always check mail before it goes"
```

The first matching rule wins and the file is re-read when it changes; a broken edit keeps the last good rules.
`osseo policy list | add | remove` edits it from a terminal and previews unless you pass `--apply`. Only you write this
file: an agent's shell command that edits it, or runs `osseo policy`, is blocked.

An `allow` rule removes the prompt only when it names send, upload, delete or pay exactly, never through `any`.

## What no rule can unlock

- Password, one-time-code and card fields are refused. Credential and security apps (password managers and the like)
  are blocked.
- Protected system paths cannot be written.
- Osseo's own control files (the Stop flag, the policy file, logs, settings) cannot be changed by the agent.

## Stop, pause, take over

- **Pause** and **Stop** are always on screen in the side panel; `osseo agent pause` / `osseo agent stop` do the same
  from a terminal, and `osseo shortcut install --apply` adds a GNOME keyboard shortcut for Stop.
- Stop blocks every state-changing call until you resume (`osseo agent resume --stop`). The agent cannot press
  Resume: the cards ignore clicks injected by software.
- `ask` hands a step to you; nothing runs until you press Continue.
- When you start using the mouse or keyboard yourself, the agent yields.

## The audit log

Every call is written to `~/.osseo/logs/osseo.jsonl`: the tool, a short summary, the risk, the decision and where it
came from (a safety floor, one of your rules, or the default classifier), and timings. Passwords, keys, tokens,
cookies, typed text and screenshots are never written. `osseo replay build --last` turns a session into a readable
page.

## Privacy

- Osseo runs on your machine. There is no telemetry, no cloud OCR, no network listener and no remote bridge; the only
  sockets are per-user files under `~/.osseo/run/`. The one optional exception is `notifications.pushUrl`: if you set
  it, Osseo posts a generic "waiting for you" message there (no preview, no app name, no token).
- What Osseo returns to your agent (the numbered lists, screen text, pictures) goes to that agent, and from there to
  its model provider, like anything else the agent reads. Use `guide.show` or `ask` for screens you do not want sent.
- Approval tokens are stored locally with owner-only permissions and never written to logs.
- The on-screen cards never show typed text or page content.

## Reporting a problem

See [SECURITY.md](../SECURITY.md). Please report any way to run a consequential action without the approval you gave,
to press a control on your behalf, or to get a secret into a log.
