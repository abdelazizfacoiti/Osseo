# Architecture

## Packages

| Package | What it holds |
|---|---|
| `packages/core` (`@osseo/core`) | Risk tiers, the safety classifier, policy file, confirmations, config, redaction, types. No app- or OS-specific code. |
| `packages/mcp-server` (`@osseo/mcp-server`) | The MCP server: tool definitions (`src/tools/`), the tool runner, the shared host, the on-screen activity (cards, timeline, frame). |
| `packages/os-linux` (`@osseo/os-linux`) | Linux adapter: windows, input, capture, accessibility (AT-SPI), OCR, the agent's browser (DevTools protocol), the Wayland portal. |
| `packages/os-windows` (`@osseo/os-windows`) | Windows adapter: one PowerShell helper (Win32 bindings emitted in memory, no compiled code) and UI Automation. |
| `packages/app-overlay` (`@osseo/app-overlay`) | The overlay manager and the GTK3 renderer (`runtime/gtk3-renderer.py`) that draws the panel, cards and frame. |
| `packages/osseo-cli` (`@osseo/cli`) | The `osseo` command. |
| `packages/browser-extension` | A browser extension and native host for the person's own browser (allow-listed sites only). |

## A tool call

```text
client ──stdio──► shim ──unix socket──► host ──► session ──► tool runner
                                                   │
      schema ► Stop/pause/takeover gate ► preview ► approval ► handler ► check ► audit
```

1. **The shim and the host.** `osseo start` runs a thin stdio shim that connects to one per-user host over
   `~/.osseo/run/host.sock` (mode 0600). The host keeps one MCP session per client and one overlay renderer for all of
   them, and gives state-changing calls a lease one at a time. Without a host (`OSSEO_HOST=0`) the server runs inside
   the client's process instead.
2. **The tool runner** (`packages/mcp-server/src/tool-runner.ts`) is the only way a handler runs. It validates the
   input, checks the run state, asks the classifier and the policy file, mints or checks a confirmation, runs the
   handler, and writes the redacted audit line.
3. **Numbered tools** (`see`, `click`, `type`, ...) resolve a number to a target and call the underlying tool
   (`desktop.click`, `browser.click`, `ui.activate`, ...) through the same runner, so nested calls are gated and
   audited too.
4. **Checks after an action**: a before-and-after capture of the window, a read-back of typed text, and a comparison
   of the accessibility tree.

## Design rules

- Core is app-agnostic and OS-agnostic; adapters fill one contract.
- Every new tool declares its execution class and risk, and goes through the runner. Nothing acts outside it.
- Anything that can send, upload, delete or pay needs an exact, single-use confirmation.
- Logs never hold secrets, typed text or screenshots.
- On Windows nothing is compiled at run time (no `Add-Type` with C#): an antivirus once quarantined a compiled helper.

More depth on specific parts: [design notes](notes/).
