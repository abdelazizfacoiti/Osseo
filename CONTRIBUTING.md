# Contributing

Osseo is provider-agnostic and safety-first. Changes must preserve schema validation, the policy file and its floors, dry-run and single-use confirmation boundaries, stop/takeover gates, target binding, redaction, and audit logging.

## Workflow

- `main` is stable; work happens on `develop`. Fork the repository, branch from `develop`, and open the pull request against `develop`.
- Keep a change small and say what you ran. Use a short imperative commit subject (`fix(overlay): ...`, `feat(cli): ...`).
- Add or update a test next to the code (`__tests__/` in each package). Node 20 or newer.
- Report vulnerabilities privately, see `SECURITY.md`.

Before submitting a change:

```bash
npm run build
npm test
npm run lint
npm run smoke:mcp
npm run docs:check   # after changing a tool: npm run docs:tools
git diff --check
```

Do not add hidden persistence, public listeners, arbitrary generated-code execution, credential extraction, CAPTCHA/MFA bypass, silent send/submit/upload/delete/pay actions, scheduler workers, or autonomous loops. Do not include private content, secrets, screenshots, OCR text, or runtime tokens in tests, fixtures, logs, or release artifacts.

New adapters and product surfaces require explicit execution metadata,
bounded tests, and the same preview/token/stop/audit path as existing tools.
The public artifact is the Linux archive/CLI; the root npm package is
intentionally private.
