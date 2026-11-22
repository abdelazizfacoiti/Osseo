# Development

Node 20 or newer. On Linux the desktop checks also need the packages in `requirements-linux.txt`.

```bash
npm ci
npm run build      # tsc -b, all packages
npm run lint       # type check
npm test           # vitest, every package
npm run smoke:mcp  # the built server over stdio
```

Tests live in `src/__tests__/` in each package; run one file with
`npx vitest run packages/core/src/__tests__/<file>.test.ts`. Tests that need a display or PyGObject skip themselves
without one.

## Checks before a change lands

| Command | What it proves |
|---|---|
| `npm run check:live` | About 90 end-to-end checks on a nested display: verified clicks, typing, labels, plans, file dialogs, the agent's browser, approvals. Opens a small window for about a minute. |
| `npm run benchmark:suite` | 25 browser tasks in headless Chrome; fails below 90% success or on any unverified success. Runs in CI. |
| `npm run benchmark:desktop-actions` | Latency of see, click, key, type and plans on a nested display, plus a check that a click by picture position lands on its target. `--server <index.js>` measures another build. |
| `npm run benchmark:form` | One form task four ways, with a gate on calls, bytes and unverified results. |
| `npm run docs:check` | `docs/tools.md` matches the server, and no doc names a tool that does not exist. Runs in CI. |
| `npm run test:windows` | The tests that also apply on Windows (CI runs them on windows-latest). |

## Docs

`docs/tools.md` is generated: run `npm run docs:tools` after changing a tool's name, description or inputs.
Everything else in `docs/` is written by hand; keep it to what the code does today.

## Branches and commits

- `main` is stable. Work happens on `develop`; open pull requests against `develop`.
- One change per commit, with a short imperative subject: `fix(overlay): ...`, `feat(cli): ...`, `docs: ...`.
- CI runs build, lint, tests, smoke, the browser benchmark suite, the docs check, a Windows job and a gitleaks scan of
  the whole history on every push to `main` and `develop` and on every pull request.

## Releases

```bash
npm run release:build            # release/osseo-v<version>-linux-x64.tar.gz and a SHA256SUMS file
npm run release:build:windows    # the Windows zip, from the Linux stage
```

The release scan refuses credential-like text, personal paths, logs, screenshots and caches.

See also [architecture](architecture.md), [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md).
