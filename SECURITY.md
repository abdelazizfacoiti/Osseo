# Security policy

Osseo lets an AI agent act on a real computer, so its safety rules are the product. Please report anything that
weakens them.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: **Security tab → Report a vulnerability** on this
repository. Include the Osseo version (`osseo version`), your platform and session type, and the smallest
redacted reproduction.

Never send passwords, API keys, confirmation tokens, cookies, screenshots, page content, OCR text, private messages or
complete audit logs.

You can expect an acknowledgement within a few days. This is an early project with a single maintainer, so fixes are
best effort, but safety bypasses are handled first.

## What counts

Most important: any way for an agent, or for text an agent reads, to

- run a consequential action (send, upload, delete, pay, private-data read) without the exact approval the person gave;
- press Stop, Pause, Resume, Approve or Deny on the person's behalf (the cards accept only a real pointer press);
- clear or edit the stop flag, the policy file (`policy.toml`), the audit log or any control-plane path;
- read or write a protected system path, a password, one-time-code or card field, or a credential app;
- leak a secret into the audit log, the failure log, a replay or a screenshot.

Also in scope: the shared host's socket, the browser extension and its native host, and the install and update scripts.

## Safety baseline (do not weaken in a fix)

- The MCP server speaks stdio. The only other listeners are per-user Unix sockets under `~/.osseo/run/` (mode
  0600): the optional shared host and the browser-extension host. There is no network listener.
- Every tool call passes schema validation, the stop/takeover gate, an effect preview and, for consequential actions,
  an exact single-use confirmation token before it runs, and is written to a redacted audit log.
- Rules live in `~/.osseo/policy.toml`. Only the host process writes it; agent commands that edit it are blocked.
- Password, one-time-code and card fields are refused. Credential and security apps are blocked.

## Supported versions

Only the latest release and `main` are supported. Linux is the supported platform; Windows is in progress.

## Out of scope

- Actions the person explicitly approved.
- Issues that need an attacker who already controls the person's account or can write to their home directory.
- Denial of service against a machine the agent is already allowed to operate.
