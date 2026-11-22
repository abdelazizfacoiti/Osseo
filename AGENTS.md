# Osseo — Codex Instructions

## Project mission

**Osseo** is a universal local MCP server giving agents a safe, permissioned body on a real computer. It automates many apps/workflows — not one specific app.

```text
Codex / agent brain
  ↓ MCP tool calls
Osseo MCP server
  ↓ safety + policy + approval
Universal automation layer
  ↓ OS adapters + optional app adapters
  ↓ any app / terminal / browser / file workflow
```

## Automation strategy order

For any task, prefer:
1. app-specific adapter → 2. official API/plugin → 3. CLI/script → 4. browser automation → 5. accessibility tree → 6. GUI screenshot/click/type → 7. guide mode

GUI clicking/typing is fallback only. Use guide mode for unsupported or sensitive apps.

## Current milestone

**Accuracy, cost, and Windows** (plan: Osseo accuracy, cost, and Windows). Milestones 1–3 are done: verified actions, label and screenshot-id targeting, set_field with read-back, file dialogs, lean results, `screen.read`, plan expectations, and the form benchmark gate. Milestone 4 (Windows) is in progress: W1 (headless: paths, shell rules, process trees, browser discovery, access lists, start-up guards) and W2 (desktop adapter: PowerShell helper, windows, screenshots, SendInput, clipboard, and UI Automation behind `ui.*`, `screen.read`, label clicks and `set_field` read-back; no OCR on Windows) pass on Windows 11 (`scripts\windows-check.ps1`, 12 of 12, and `scripts\windows-desktop-check.ps1`, 32 of 32, both 2026-11-16). W4 packaging: the install dry run passes, but the zip cannot be built on Windows yet (`npm run release:build` needs the Linux stage) and no real install has run (`scripts/install.ps1`, `npm run release:build:windows`, zip updates by junction, `cmd /c` client entries, Task Scheduler schedules); W3 (overlay) is written. Its safety guard passes on Windows 11 (`scripts/windows-overlay-smoke.mjs`, 10 of 10, 2026-11-16), and so does the dock strip that reserves work area (`scripts/windows-dock-smoke.mjs`, 17 of 17 including the agent's Chrome maximized, 2026-11-16). The agent's own Chrome passes (`browser.open`, form fill and submit, `scripts/windows-browser-check.mjs`, 6 of 6, 2026-11-16). The numbered tools (`open`, `see`, `type`, `click`, `wait`) pass on the agent's Chrome (`scripts/windows-see-check.mjs`, 7 of 7, 2026-11-16); `see` on the person's own Chrome lists only its chrome, by design. The cards turn on with `overlay.windows` in `config.json` or `OSSEO_WINDOWS_OVERLAY=1`. The card look follows the Linux card (checked on a screenshot). The Windows zip is built from the stage on Windows (`npm run release:build -- --stage-only`). W4 is installed on this account, and the update and rollback are verified (2026-11-17). Still to do: a person's real click on Stop with the current build (`windows-overlay-smoke.mjs`, open since 2026-11-17). Keep the P0 rules: previews and confirmation tokens for consequential actions, stop/takeover, audit, and truthful manifests. Verify source, tests, build, and smoke before claiming completion.

## Architecture rules

- **No run-time compile on Windows**: no `Add-Type -TypeDefinition` or `-MemberDefinition` (C#). The Win32 bindings are emitted in memory by `NATIVE_PS` (`packages/os-windows/src/native-ps.ts`), so no DLL is written (an antivirus quarantined one, 2026-11-17). Smoke scripts follow the same rule.
- **Core must be app-agnostic** — no app-specific imports in `packages/core`
- **Core must not import Linux-specific implementations**
- App-specific code stays out of core; there are no app adapters in this tree

## Package map

```
packages/
  core/              @osseo/core — risk tiers, capability permissions, policies, types
  mcp-server/        @osseo/mcp-server — MCP server, tools, server, resources
  osseo-cli/     CLI tool (bin: osseo)
  app-overlay/       GTK3 renderer + overlay manager + task progress card
  os-linux/          OS adapters (filesystem, desktop, dependencies, window mgmt)
  os-windows/        Windows desktop adapter (PowerShell helper, SendInput, GDI); selected in server.ts on win32
  browser-extension/ Manifest V3 extension and native messaging host for the person's own browser (not connected to the MCP server yet)
```

## Key commands

| Command | What it does |
|---|---|
| `npm run build` | `tsc -b` — build all packages |
| `npm run lint` | `tsc -b --pretty false` |
| `npm run test` | `vitest run` — all packages |
| `node scripts/measure-tools.mjs` | Start the built server in each tool profile and print the tool count and `tools/list` bytes (desktop: 14 tools; full: all) |
| `npm start:mcp` | Run MCP server |
| `npm run smoke:mcp` | Smoke test |
| `npm run check:live` | End-to-end check of this build (87 checks, including the numbered-action section, which `LIVE_CHECK_ONLY=numbered` runs alone): CLI help and resume, verified clicks, typing, labels, set_field and screenshot ids on a nested display, self-pause, headless-Chrome forms with an iframe, session end (cards close when the client disconnects), file dialogs, and plan expectations. Opens a small window on your screen for about a minute; it runs on a private D-Bus session bus (`scripts/private-bus.mjs`), so it cannot touch your real AT-SPI socket. |
| `npm run release:build:windows` | Build `release/osseo-v<version>-win-x64.zip` (+ fixed-name copy) from the Linux release stage with Node only; run after `release:build` |
| `npm run test:windows` | The unit tests that do not assume Linux (run in the `windows-headless` CI job and by `scripts\windows-check.ps1`) |
| `node scripts/windows-smoke.mjs` | The built server over stdio on any OS: tools, files, protected paths, shell classification, browser, tasks |
| `npm run benchmark:form` | One form task four ways (pixel before, pixel after, browser, and numbered: only see, type, click, key and wait) with the gate: 50% fewer calls, 40% fewer bytes, no unverified successes. The pixel routes need headed Chrome, Xephyr, and GTK. |
| `npm run benchmark:agent` | Non-destructive runner/plan overhead benchmark in an isolated home |
| `npm run benchmark:desktop` | Non-destructive Linux desktop-backend latency benchmark |
| `osseo integrations <client> add\|status\|remove [--apply]` | Register/preview/remove the MCP server for opencode, Claude, Codex, Copilot (VS Code + CLI), or Cursor |
| `npm run skill:install -- --target all` | Install portable `skills/osseo` skill and register the MCP server (opencode/Claude/Codex/Copilot VS Code + CLI/Cursor); `--no-mcp` for skill text only |
| `osseo task watch <id> [--follow] [--notify] [--overlay]` | Tail redacted task progress; `--overlay` shows a persistent card |
| `osseo overlay hide [--orphans]` / `overlay status` / `overlay check-input` | Cross-process hide marker + renderer diagnostics; `check-input` shows a test card that only a real hardware press can accept |
| `osseo task export <id> [--format md\|html]` | Shareable redacted run report |
| `osseo confirmations` / `confirm <tokenId>` / `deny <tokenId>` | Inspect and resolve exact-preview confirmation tokens |
| `osseo viewer start [--display :N] \| stop \| status` | Small GTK view of the background display (`packages/app-overlay/runtime/viewer.py`) with Pause, Resume and Stop; frames from `captureDisplayFrame` (scrot) into `run/viewer/`; the window only reads files |
| `osseo tray start \| stop \| status` | Status icon in the system tray (StatusNotifierItem, `packages/app-overlay/runtime/tray.py`) showing running, paused, stopped or waiting for approval, with a menu of Stop, Pause, Resume and Open viewer. A menu item runs only on a real pointer press (`on_item`, the viewer's helpers); Resume also needs physical hardware. GNOME needs the AppIndicator extension |
| `osseo portal check [--start]` | Checks the desktop portal that the Wayland path uses (`packages/os-linux/runtime/portal_helper.py`). Without `--start` it creates and closes one portal session and shows no dialog; `--start` asks the person once through the portal's own dialog and reports the granted screen. A real answer needs a Wayland login |
| `osseo journal show [--session <id>] \| save <name> [--session <id>] [--last <n>] [--apply]` | Steps the agent took through numbered actions, and a saved workflow built from them (preview unless `--apply`) |
| `osseo selftest [--json] [--viewer]` | Prove the installed build works in a few seconds: built server, headless Chrome, a local form filled by number; exit 0 when every step passes. `--viewer` runs the same form on a background display (nested Xephyr) that the viewer shows on the person's screen, adds a Send step that must ask first, and checks that the viewer draws frames; it needs DISPLAY, Xephyr and Chrome, and it opens windows on that screen |
| `npm run benchmark:suite` | 25 local-HTML browser tasks in headless Chrome, one isolated home per task; prints a table and the gate (success rate at least 0.9, zero unverified successes); `--tasks`, `--runs`, `--out`; needs no display |
| `osseo replay build [--session <id> \| --task <id> \| --last] [--out <file>]` / `list` / `open <id>` / `delete <id> [--apply]` | Single-session HTML page from the audit log, summaries only (no screenshots, no typed text); stored in `~/.osseo/replays`, pruned at 14 days or 50 MB |
| `osseo policy list\|add\|remove <line> [--apply]` | List, add and remove `policy.toml` rules; `add --action <a> --decision <allow\|ask\|never> [--app <name>] [--site <host>] [--note <text>]`; preview unless `--apply`; `confirm <id> --always` writes the "Always allow here" rule |
| `osseo failures [summary] \| show [--last <n>] \| clear [--apply]` | Development failure log: every unexpected tool failure from every session, grouped by tool and error code, most frequent first (`--since 7d`, `--tool <name>`, `--json`); read it to pick the next fix. `clear` previews unless `--apply` |
| `osseo task pause <id>` / `task resume <id>` | Task lifecycle transitions (not a stop-flag clear) |
| `osseo agent status` / `pause` / `stop` / `takeover-begin` / `resume --stop\|--takeover\|--pause` | Runtime pause/stop/takeover flags; resume is operator-only |
| `osseo workflow list\|show\|run\|delete <name> [--param k=v] [--unattended]` | Saved, parameterized plans; `run` goes through `computer.run_steps` and never auto-approves (exit 2 = needs approval) |
| `osseo schedule list\|add\|remove <name> (--daily HH:MM\|--weekdays HH:MM\|--every 30m) [--apply]` | systemd user timers for saved workflows; preview by default |
| `osseo setup guide` | First-run path (`packages/osseo-cli/src/guide.ts`): makes the home, lists missing desktop packages with the install command, runs the self-test, finds agent clients on PATH and prints `integrations <client> add --apply` for each unregistered one, then one safe first prompt. Installs nothing, edits no client config; exit 1 when the self-test fails |
| `osseo setup deps [--apply]` | Check desktop packages from `requirements-linux.txt`; `--apply` installs missing ones through sudo/pkexec (password prompt) |
| `osseo attention request --source <client> --reason <permission\|confirmation\|idle\|done>` / `clear [--restore]` / `status` | Raise the agent's terminal for a pending approval and return focus afterwards; called by client hooks |

**Test order**: `build → lint → test`. Run a single test file: `npx vitest run packages/core/src/__tests__/<file>.test.ts`. Tests live in `__tests__/` dirs inside each package's `src/`.

**Build is project-wide**: `tsc -b` reads `tsconfig.json` references. Build individual packages with `npx tsc -b packages/core`.

## Default policy

`~/.osseo/policy.toml` holds the rules (`packages/core/src/policy-file.ts`, gate in `packages/mcp-server/src/policy-gate.ts`). A rule has `action` (any, send, upload, delete, pay, navigate, type, click), optional `app` and `site`, a `decision` (`allow` no prompt, `ask` prompt each time, `never` refuse) and a `note`. First match wins; the file is re-read when it changes; a bad edit keeps the last good rules. Without a file, send, upload, delete and pay ask and everything routine runs directly.
Precedence: floors (blocked tier, password/OTP/card fields, password managers, control plane), then file rules, then the classifier. An `allow` removes a prompt only when it names send, upload, delete or pay exactly, never through `any`. The audit entry has `policySource` (`floor`, `policy_rule:<line>`, `classifier`).
"Always allow here" (chat checkbox `alwaysAllow`, card button `always`, `osseo confirm <id> --always`) approves once and writes one rule through `alwaysAllowFromConfirmation`, using the `policyTarget` stored on the confirmation. Refused with a reason: category `any`, navigate/type/click, unknown app and no site, blocked. Only the host process writes the file, atomically; agent shell commands that edit it or run `osseo policy add|remove` are blocked.
`osseo policy list|add|remove` edits it from a terminal (preview unless `--apply`). Credential/security apps, secret data and protected system paths stay blocked. `browser.*` tools drive a dedicated Chrome profile over the DevTools Protocol (`packages/os-linux/src/browser-session.ts`, `packages/mcp-server/src/tools/browser.ts`), never the person's own profile, and refuse password/OTP/card fields.

## Safety model

Every tool passes through: schema validation → stop/takeover gate → effect preview → dry-run token or explicit confirmation → execution → redacted audit logging.

- Risk tiers: `observe` / `low` / `medium` / `high` / `blocked`
- Routine state-changing tools execute directly. Consequential actions — external/destructive effects, private-data reads, or high risk — require a dry-run preview and exact confirmation; metadata-only task/agent control is exempt.
- Dry-run for a consequential action mints a 15-minute single-use token bound to tool, canonical arguments, and target. `osseo confirm <tokenId>` approves one exact preview; `deny` rejects it. Accepted confirmation sets `confirmationSatisfied` for the handler safety recheck.
- `osseo task approve <id> [--max-risk low|medium]` creates a 30-min approval for an **active** task; the runner auto-chains only low/medium effects. High and consequential effects still need per-action tokens.
- `computer.run_steps` executes up to 20 named tool calls through the same runner. A confirmed plan token covers only low/medium effects inside that exact plan fingerprint; high-risk steps still require their own token, and nested plans are rejected.
- Stop/pause enforcement via `run/stop.requested`, `run/takeover.active`, and `run/pause.requested`; `emergency_stop_requested`/`human_takeover_active`/`pause_requested` gate only state-changing calls.
- The automatic action card exposes Pause/Resume/Stop and a close button; approval waits stay visible, raise above other windows, send a best-effort desktop notification, and the close button still works after the MCP server exits.
- Osseo control-plane paths (`run/`, `logs/`, `setup/`, `tasks/approvals/`, config) are read-medium and write/delete-blocked.

## Logging

Every session's server also appends each unexpected tool failure to `~/.osseo/logs/failures.jsonl` (`packages/core/src/failure-log.ts`, hooked in `tool-runner.ts` after the audit write; read with `osseo failures`). It stores the tool, error code, redacted message (home as `~`), the audit input summary, the first observation as `hint`, build, platform and placement, never typed text. Confirmation prompts, pause, stop, takeover and user-active results are skipped as expected; preview-only plan steps are skipped; rotates at 5 MB to `failures.1.jsonl`; a write failure never changes a tool result. It sits in `logs/`, so agents cannot edit it.

All tool calls logged as JSONL to `~/.osseo/logs/`. Never log passwords, API keys, tokens, cookies, private keys, full sensitive files, or screenshots.

## Key files & paths

- `~/.config/osseo/config.json` — the config file (`osseo setup` creates it). `~/.osseo/config.json` is read only when it does not exist; `osseo config path` shows which one is active and warns when the other differs. `osseo start` passes the active file as `OSSEO_CONFIG`.
- `~/.osseo/` — logs, screenshots, runtime data
- `~/.osseo/logs/` — JSONL audit logs
- `~/.osseo/screenshots/` — captured screenshots
- `~/.osseo/outputs/` — task reports and generated artifacts
- `~/.osseo/tasks/` — persistent task JSON
- `~/.osseo/workflows/` — saved, parameterized plans (`workflow.*`, `osseo workflow`)
- `~/.osseo/browser/profiles/agent/` — dedicated Chrome profile for `browser.*` (never the person's own profile)
- `~/.osseo/memory/lessons.json` — short agent lessons (`memory.*`, `osseo memory`)
- `~/.osseo/run/handoff.active` — active human handoff (raises takeover; blocks screen-reading tools)
- `~/.osseo/run/confirmations/` — pending/accepted single-use tokens
- `~/.osseo/run/stop.requested`, `run/takeover.active` — operator gates

## Environment gotchas

- **AZERTY keyboard**: `desktop.type_text` auto-routes ASCII letters/digits/space through `xdotool type` and everything else through clipboard paste. The paste uses `xclip`/`xsel` when installed, otherwise a built-in python3-gi helper (`packages/os-linux/src/gtk-clipboard.ts`) that owns the selection only for the paste and then restores the prior clipboard through a detached owner that exits when anything else copies.
- **Window coordinates**: `wmctrl -G` double-counts the offset of root-parented (CSD) windows; `listRawWindows` corrects every window from one `xwininfo -root -tree` call. Screenshots return `screenshotMetadata.screenOrigin` so image pixels map to screen coordinates (`origin + image / scale`).
- **Dock and timeline**: `overlay.layout` defaults to `dock` (right, 18%, reserved strut). `ActionTimeline` (`packages/mcp-server/src/action-timeline.ts`) renders a newest-first `timeline` component inside the dock with pinned approval/stop/pause alerts and display-only merging of repeated finished entries; card bodies scroll while header/footer stay pinned, and `dock_layout` (`overlay_geometry.py`) keeps the timeline above bottom cards so Pause/Resume/Stop never get covered; labels come only from allowlisted input fields (coordinates, key names, app names, counts), never typed text. In dock mode only the timeline and bottom cards live in the dock; pills and approval cards float over the work area. During screenshot capture the dock is made transparent (strut kept) instead of destroyed.
- **Host attention**: `HostAttention` (`packages/mcp-server/src/host-attention.ts`) raises the agent's terminal/IDE window on `confirmation_required` (found by walking `/proc` parents to a window owner) and refocuses the recorded work window when the agent retries with the token. `osseo integrations claude add` also installs Claude Code `PermissionRequest`/`Notification`/`PostToolUse` hooks that call `osseo attention`. `osseo integrations codex add` also sets a top-level `notify` in `~/.codex/config.toml` (above any table, never over another notify program) so the terminal is raised when a Codex turn ends; Codex's own approval prompts are still not covered.
- **Run-control buttons**: Pause/Resume/Stop/Cancel on overlay cards accept only pointer/touch activation; keyboard or accessibility "clicks" are ignored. The runner also touches `run/input-active` around every injected input (`packages/mcp-server/src/input-guard.ts`); the renderer ignores control presses within 1s of it, so an agent cannot click Resume/Stop on its own cards. The renderer also ignores control presses whose GTK source device is an XTEST device (`xdotool` via `shell.run`) unless `overlay.allowSyntheticControl` is set; Approve/Deny on `ApprovalOverlay` and Continue on `HandoffOverlay` use the same guard. `TRUST_EVENTS` (accepted, always, continue, resume) must also prove a physical device via `overlay_input.py`: uinput devices are identified by their sysfs path, never by name, and Stop/Pause deliberately skip that check. Do not mark a footer container `no_show_all` without showing its buttons explicitly: `show_all()` then skips them.
- **Focus drift**: when a desktop action pins `activeWindow.windowId`/`target.windowId` and focus drifted (e.g. back to the terminal), the action re-activates that exact window once and re-verifies instead of failing.
- **Desktop requirements**: `LINUX_DESKTOP_REQUIREMENTS` (`packages/core/src/requirements.ts`) mirrors `requirements-linux.txt` (a test keeps them equal). On first start the MCP server offers one pkexec-prompted `apt-get install` of missing packages per missing set (`requirements-bootstrap.ts`, marker `run/requirements.json`); set `autoInstallDependencies: false` to disable. It never installs silently.
- **Second Firefox window**: `xdotool windowactivate` may fail with `BadWindow`. Use `xdotool search --name <pattern>` to find correct window ID.
- **Focus-safe desktop**: `window.focus` returns `previousWindow` (best effort) so agents can restore user focus; focus changes are reported, never silent.
- **Accessibility tools**: `ui.tree`, `ui.find`, `ui.activate`, `ui.set_text` wrap the AT-SPI layer in `packages/os-linux/src/accessibility.ts` and default to the active window's app. UI reads of credential/security apps are blocked (stricter than core `inspect`).
- **Automatic action card**: `overlay.mode` selects triggers (default `always`: computer-action families plus state-changing; `on_change`: state-changing plus confirmation fallback; `off`: none). Cards open before preview/handler work in `packages/mcp-server/src/action-overlay.ts`, show running/waiting/preview/done/failed/halted in place, honor persistence/auto-hide, and can render as a compact top-center pill with an ambient edge frame and target ring for click/pointer/focus targets. Ring geometry and card placement are clamped to monitor/work-area bounds; cards avoid the target when possible. `overlay.frame`, `overlay.actionPill`, `overlay.targetRing`, `overlay.targetRingLeadMs`, and `overlay.targetRingDurationMs` control these surfaces. Frame/ring motion uses Cairo when available and per-widget GTK CSS fallbacks otherwise; reduced motion keeps both static. Dock layout (`overlay.layout: "dock"`) uses `xprop` to reserve X11 work area when `dockReserveSpace` is enabled; `overlay.dockSide` and `overlay.dockWidthPercent` size it. If `xprop` is unavailable, the dock remains visible without claiming reserved work area. Cards wait at most 150ms for a routine first paint (1.5s while approval is pending), and never block execution on overlay failure. Startup prewarms the renderer and sweeps orphans.
- **Automatic current-task card**: `TaskActivityOverlay` (`packages/mcp-server/src/task-overlay.ts`) keeps one persistent public card for the active task, mirroring goal/phase/current action, definition-of-done checklist, running-task count, and Pause/Resume/Stop from `task.*`. Without an explicit task, `always` mode shows an implicit `Computer activity` card; a real task replaces it and an explicit dismissal sticks. It restores recent active/paused tasks on server start (24h freshness), keeps terminal cards until dismissed, and fails best-effort. `overlay.mode: "off"` skips it; `osseo task watch <id> --overlay` remains optional.
- **Task progress card**: `TaskProgressOverlay` (in `packages/app-overlay/src/task-progress.ts`) renders status, checklist, `Step n/m`, elapsed time, approval command, and Pause/Resume/Stop. Pause requests the scoped global pause and shows Paused with Resume immediately; Stop never kills an in-flight tool call. Construct the renderer and manager with the **same sessionId**. A card stopped from the stop flag (Stop button or the flag seen in `#syncRunState`) is `stopped(detail, { resumable: true })` and shows Resume and Dismiss; a real-pointer Resume clears the stop flag like `osseo agent resume --stop`, and a cancelled task keeps Dismiss only.
- **Overlay event routing**: multiple cards share one `OverlayManager`; call `pollEvents(overlayId)` so each card consumes only its own events. The manager buffers unmatched events for other cards. Pause reasons are scoped: action-card resume clears only `agent_action_card_pause`; task-card resume clears only `agent_task_overlay_pause:<taskId>`.
- **Renderer concurrency**: `LinuxOverlayRenderer` must treat a child with a passed handshake as started even while `runtimeState === "rendering"`. Event polling can overlap an in-flight update; restarting or killing the renderer in that window makes task cards disappear.
- **Overlay visibility status**: `run/activity.json` records the last action card's started/visible/error state; `osseo overlay status`, `osseo doctor`, and `osseo://status.lastActivity` surface it so a silent fallback is visible.
- **Attention chime**: `attention-chime.ts` plays a soft two-note chime (sine, slow fade, about 16% volume, `run/attention-chime.wav`) every 8 s while an approval token is still pending or a hand-off is active, and raises the agent's terminal or IDE (`HostAttention`). It stops when the agent retries with the token, when chat approval answers, when the request is no longer pending, or after 5 minutes. Player: `pw-play`, `paplay`, `aplay` (Linux), `afplay` (macOS), `Media.SoundPlayer` (Windows). Off with `attention.sound: false` or `OSSEO_ATTENTION_SOUND=0`; `attention.soundIntervalMs` sets the gap.
- **Chat approval**: `chat-approval.ts` asks through MCP elicitation after a `confirmation_required` result (`approvals.chat: false` disables it). The client shows the prompt, so the agent cannot answer it. Cards and the CLI stay as fallbacks.
- **Approval signaling**: a new `confirmation_required` result raises the action card via warning styling and sends one best-effort `notify-send` per 5s window. The notification names `osseo confirmations`, never a token value.
- **Background placement**: `execution.placement: "background"` starts Xephyr (`packages/os-linux/src/background-display.ts`) and every desktop call receives its env through `desktopContext` in `server.ts`. Any new desktop spawn must honor `context.env`, or it acts on the real screen. It is also the Wayland path. `ui.*` is refused there (AT-SPI is session-wide).
- **Edge frame and `frame: "always"`**: the frame is four 6 px click-through strips per monitor (`ensure_frame_strips` in `gtk3-renderer.py`, painted by CSS; `new_popup` sets app-paintable, so a strip turns it off), not a full-monitor window. `overlay.frame` is `true` (a frame around actions, as before) or `"always"` (`ToolActionOverlay.startFrame()` at server start): a quiet gray frame whenever the server runs, blue while an action runs, green when done, amber when waiting or paused, red on error, and back to gray after the card goes; it is removed only when the overlay closes. The renderer expires primitives after 5 minutes, so `startFrame` shows it again every 120 s. With several sessions on one renderer the most urgent colour wins. Capture: `workCleanBase` in `server.ts` treats `"always"` as clean, and a configured ring blocks a window capture's clean path only while one may be on screen (`captureCleanNow`, `ToolActionOverlay.ringActive()`), so a window-only `desktop.screenshot` no longer clears the cards. A window that touches a screen edge would still contain the strip pixels (the terminal's bottom rows came back green in the first real test), so `frameTrim` (`frame-trim.ts`) crops those pixels with ffmpeg through the screenshot `trim` option and `screenOrigin` moves by the cut. Full-screen captures still clear all surfaces. Keep `OVERLAY_FRAME_THICKNESS` equal to `FRAME_THICKNESS` in the renderer.
- **Window captures and cards**: any Osseo window drawn over the verified window corrupts a window-only capture (`xwd -id` returned zeros and foreign pixels while a managed or override-redirect window was mapped over it, under Mutter X11). `withScreenshotSuppressed` therefore clears and re-creates every card around each capture, which blinks the screen. Keep cards out of the work area: `workWindowCaptureClean` (dock layout, dock reserving space, no floating pill, frame or ring) skips the suppression for window-only captures. GNOME's `org.gnome.Shell.Screenshot.ScreenshotWindow` denies this caller.
- **Speed work** (`docs/notes/speed-plan.md`; measure with `npm run benchmark:desktop-actions`, optionally `-- --server <other build>`): effect checks use `captureLinuxWindowFast` (one chained xdotool call for the rectangle, one `scrot -a`; off with `OSSEO_NO_FAST_CAPTURE=1`); `measureEffect` waits at least 100 ms after the action (apps react after the input), polls every 40 ms, and waits for the hover to settle (two matching captures, at most 250 ms) instead of a fixed time; inside a plan only the last step takes the pixel check and the control comparison unless the step has an `expect` (`planStep.checked`), the window list is read once before the first and once after the last step, and plan previews run concurrently; accessibility queries run in a long-lived Python worker (`py-worker.ts`, `OSSEO_NO_PY_WORKER=1` turns it off, a hung query kills it and answers 124); `set_field` polls instead of sleeping 150 and 200 ms; `see` on an app without an accessibility tree OCRs only the window's rectangle, caches by image hash for a minute and runs Tesseract with `OMP_THREAD_LIMIT=1`; a repeated call that changed the screen is progress, not a loop (`madeVisibleProgress`); `key`/`desktop.hotkey` take `sequence`. Racing keys against a dropdown popup is timing dependent: choose options with `type { n, text }` (a combobox goes through `browser.select`).
- **Verified actions**: `desktop.click|type_text|hotkey` measure the window before and after (`packages/os-linux/src/effect.ts`, `measureEffect`), hover the target before clicking, and return `effect.screenChanged`. Screenshots return an inline JPEG through `downscaleToJpeg` (ffmpeg). `toMcpToolResult` turns `data.inlineImage` into MCP image content. Typing pastes by default: direct xdotool typing swapped W and Z on AZERTY. The paste key depends on the focused app (`pasteKeyFor` in `desktop.ts`): terminals take Ctrl+Shift+V, xterm takes Shift+Insert, everything else Ctrl+V.
- **see and numbered actions**: `see` (`packages/mcp-server/src/tools/see.ts`) returns one numbered list per window (browser DOM when the window is the agent's own browser page, else the accessibility tree, else OCR words, else nothing) and stores each number in `view-registry.ts` (5 min, 10 views, one per window, screen targets stale when the window moved). `click`, `type`, `key`, `scroll`, `drag`, `open`, `windows`, `wait`, `ask`, `steps`, `status` (`tools/numbered.ts`) resolve a number and call the existing tool through `callGoverned` (`nested.ts`, same runner path as `computer.run_steps`). They set `delegatesExecutionArgs`, so the runner leaves `dryRun`/`confirmationToken` for the nested call and a `confirmation_required` result comes back with the new tool name. `tools.profile` (`desktop` default, `full`; env `OSSEO_TOOLS_PROFILE`) only changes what `tools/list` and the capability resources show (`tool-profile.ts`); every old tool stays callable, and a direct call in the desktop profile adds a hint naming the new tool. `see` is `state_changing` like `desktop.screenshot` (it may write a picture) and is on the handoff block list; the other wrappers are `metadata_only` because the nested tool is gated and counted. Scripts that list or count tools set `OSSEO_TOOLS_PROFILE=full`.
- **Fast decisions**: `task.create` guidance tells the agent to inspect once, act, then verify; the runner nudges on the 3rd and 6th identical call.
- **Plans and traces**: `computer.run_steps` audits the wrapper plus every nested call; preview-only nested calls never mint tokens. Set `OSSEO_TRACE=1` for timestamped redacted phase traces under `~/.osseo/logs/traces/`; trace failures never affect execution.
- **State-changing concurrency**: one MCP context serializes state-changing handlers through `execution-gate.ts`, allows read-only calls concurrently, and rechecks stop/takeover after queueing. `run_steps` nested calls are reentrant in the same async lane.
- **Screenshot options**: `desktop.screenshot` supports `format`, `quality`, `scale`, and `region`; native `scrot -a` avoids crop post-processing, and JPEG/crop/scale require `ffmpeg` or fail explicitly.
- **Screenshot suppression**: `desktop.screenshot` captures through `overlayScreenshotSuppression`; screenshot content must never include Osseo cards. Direct `showWidget`/`updateWidget` calls are rejected while suppression is active, then surfaces are restored.
- **Overlay click-through**: the automatic action card is click-through; small interactive card windows are reserved for Pause/Resume/Stop controls. Fullscreen surfaces are created only for pointer/arrow/highlight/spotlight primitives and must stay click-through. Do not reintroduce a fullscreen surface for ordinary cards.
- **Overlay updates**: use `manager.updateWidget()` for in-place changes. Do not `dismiss` + `show` on every tick; that causes flicker and resets controls.

- **AT-SPI lookups**: `matches_app` asks for the pid before the app name, because
  one hung app took 14.7 s to answer its name and every lookup then timed out.
  `find` walks 14 levels (web content sits deep below the browser chrome).
  Chrome exposes page controls to AT-SPI only with `--force-renderer-accessibility`.
- **Card renderers hold pipes to their server**: closing the client's stdin must
  exit the server (`startStdioServer`), which closes cards first. A server from
  an older build keeps its renderer alive; `osseo overlay status` lists them.
- **Screenshot ids live in the server process** (`screenshot-registry.ts`). A
  restarted server forgets them, and a click on an unknown id fails with
  `screenshot_unknown`.
- **Guide mode**: `guide.show` / `guide.clear` (`packages/mcp-server/src/tools/guide.ts`) draw a
  `highlight` plus a `tooltip` per step as `window_region` primitives and never click. Steps resolve
  before anything is drawn, so one bad step shows nothing. Labels use AT-SPI only (no OCR, which has
  no box). The overlay manager keeps marks at most 300 s whatever `ttlSeconds` says. While a guide is
  up, `guideActive` makes window-only captures in `desktop.ts` use card suppression again
  (`windowCaptureClean`), because a mark over the window corrupts the capture. `waitForClick` uses `waitForPointerPress` (`packages/os-linux/src/pointer-watch.ts`), which only reads pointer state, and ignores presses within 1 s of the `input-active` guard file. The guide polls the stop flag once a second and removes its marks on Stop. With `waitForClick` and several steps, a Teach card (`Step n of m`, Back, Next, and Done on the last step) sits beside the current box while all boxes stay drawn. `teachLoop` runs the walkthrough and ends at Done, at a click in the last box, on timeout, on clear or on Stop (result `finished: true`). The Back and Next buttons send the pointer-only `back` and `next` events (`CONTROL_EVENTS` in `gtk3-renderer.py`; `teach_selftest.py` checks them on a nested display). Without a renderer that can draw widgets, or when the card cannot be drawn, the guide uses tooltips.
- **Capability grants are gone**: the `grants` key in `config.json` must be absent or an empty array; rules go in `policy.toml`. The classifier's own `requiresConfirmationToken` replaces the old `grantDecision` field, and `safetyContext(context)` in `packages/mcp-server/src/context.ts` builds the per-call safety context.
- **Browser extension** (`packages/browser-extension/`): a site is used only after the person allows it in the popup, and it then appears in `~/.osseo/browser-extension/allowed-hosts.json`. The extension refuses password, one-time-code and card fields and never reads cookies or storage. `refusals.mjs` and the `hostAllowed` block are copied into the extension scripts; tests keep the copies equal.
- **Window rectangle**: `getLinuxActiveWindowBounds` and `captureLinuxWindowFast` read the true client rectangle with `xwininfo -id` (`parseXwininfoRect`), because `xdotool getwindowgeometry` adds a server-side title bar to Y (Blender: 106 instead of 69). Do not use xdotool's geometry for anything that maps pixels.
- **Picture coordinates**: `see` stores how its picture maps to the screen on the view (`SeenView.picture`: `scale`, `origin`; also returned as `data.pictureMap`). `click`, `scroll` and `drag` with `x,y` (or `fromX/toX`...) treat them as pixels of the newest picture of the active window and convert with `screen = origin + pixel / scale` (`toScreenPoint` in `tools/numbered.ts`); `space: "screen"` keeps raw screen pixels, no picture means raw pixels, and a window that moved since the picture is refused with `view_stale`. A real run missed a Download button by ~177 px because the numbers were sent as screen pixels.
- **Numbered actions and structure**: after a successful `click`, `type`, `key`, `scroll` or `drag`, the numbered wrappers re-read the window's accessibility outline (same filter and max as `see`, 1.5 s, 600 nodes) and diff it against the stored view (`packages/mcp-server/src/see-diff.ts`). `data.changes`, `changeCount` and `structure` (`used`, or `unavailable` with `structureReason`) report it in words. Pixels stay the fallback. The stored view keeps its numbers until the next `see`; a sensitive field never shows a value. The audit output of the numbered tools holds only `structure` and `changeCount`.
- **browser.own_\*** (`packages/mcp-server/src/tools/own-browser.ts`, `browser-extension-client.ts`): the person's own browser through the extension and its native host. A host must be allowed by the first matching `site` rule with action `any`, or the call is refused with `host_not_allowed` before anything is sent. The server keeps `~/.osseo/browser-extension/allowed-hosts.json` (0600) in step with those rules. These tools are hidden from the desktop profile.
- **Background display record**: while background placement is on, the server writes `run/background-display.json` (`{"display": ":N"}`) and removes it on stop. `osseo viewer start` reads it when `--display` is not given.
- **Session journal** (`packages/mcp-server/src/journal.ts`): each successful numbered `click`, `type` or `key` is recorded at `~/.osseo/journal/<session>.json` (0600, 200 steps, pruned after 7 days) with the element's role and name and the length of typed text, never the text; sensitive fields are skipped. `osseo journal show|save <name> [--apply]` turns it into a saved workflow that runs with `osseo workflow run`. Saving is CLI-only and previews by default.
- **Host service (default through `osseo start` on Linux/macOS; `OSSEO_HOST=0` opts out)**: `osseo start` sets `OSSEO_HOST=1` and `OSSEO_HOST_AUTO=1`; with AUTO the shim exits 125 when no host is reachable and `runShimFromEnv` runs the in-process server instead. After `osseo update`, run `osseo host stop` so the next session starts a host from the new build. `overlay.frameIdleMs` hides the always-on gray frame after idle. With `OSSEO_HOST=1` the MCP entry runs a thin stdio shim (`packages/mcp-server/src/host/shim.ts`) that connects to a per-user host (`host/main.js`) over `run/host.sock` (mode 0600; `run/host.pid`). The host builds one MCP session per connection and holds one lease for state-changing calls (FIFO, 30 s wait, then `host_busy`); read-only calls are not leased. It exits after 10 minutes with no connections and no active task. `osseo host status|start|stop` manages it. Unset, the in-process server runs as before. The host owns one overlay renderer for all its sessions (`host/shared-renderer.ts`). Each session's overlay ids carry a `<sessionId>::` prefix and events route back by that prefix; a session's close removes only its own cards, while Stop and renderer restart act on every card. One merged dock timeline across sessions is not built.
- **Own-browser tab list**: `tabs` is a request type with no tabId or host. `filterTabsForAllowedHosts` in `packages/browser-extension/src/protocol.mjs` is the rule the native host uses; the extension and the tool re-check the allow list. Output is only `{ tabId, host, title }`. `background.js` repeats the filter inline (it is not a module), and only the `hostAllowed` block is compared by a test.
- **Stop shortcut**: `packages/osseo-cli/src/shortcut.ts` writes `~/.osseo/bin/osseo-stop` (0700, absolute node and CLI paths, each single-quoted) and one gsettings custom keybinding at `.../custom-keybindings/osseo-stop/`. It keeps other entries, refuses a slot that holds a different command, and refuses non-GNOME desktops with `unsupported_desktop`. Tests inject a fake runner and never call the real gsettings. The wrapper pins the CLI path at install time: run `shortcut install --apply` again after an update that moves the CLI.
- **Self-test**: `osseo selftest [--json]` (`packages/osseo-cli/src/selftest.ts`) runs the built server in a temp home with the overlay off and no DISPLAY, and drives a local form with `open`, `see`, `type` and `click` by number. It takes `{ mcpEntry, chromePath }` as deps. The temp directory and the server are always removed. It needs no display and never touches the person's profile.
- **Host start lock**: `run/host.lock` (O_EXCL, `<pid> <ms>`, stale after 30 s with a dead pid) is held while `osseo host start|restart` or the shim starts a host. The code is duplicated in `packages/mcp-server/src/host/start-lock.ts` and `packages/osseo-cli/src/host.ts`, so keep the two equal. `host status` counts a host as running only if it answers `{"ping":true}`. `osseo doctor` reports the host state under `host`.
- **Store admin rule**: `isShopifyAdminUrl` and `shopifyAdminAskCategory` in `packages/core/src/safety/app-sensitivity.ts` decide it. The classifier upgrades a control to ask only when the tool passes `targetName` (desktop and browser clicks; numbered `click` passes the view name). Without a name nothing changes. `desktop.click` has no page URL of its own: `namedClickSafety` takes the agent browser's URL only when its title is in the window title, and otherwise sets `shopifyHint` when the window title says Shopify (ask-only). Named clicks never change where the click goes and are never written to the audit line.
- **Replay on finish** (`replay.onTaskFinish`, opt-in): `TaskActivityOverlay.onFinished` calls `triggerReplay` in `packages/mcp-server/src/replay-trigger.ts`, which spawns the sibling `packages/osseo-cli/dist/index.js replay build --task <id>` detached with fixed arguments. The server never imports the CLI.
- **Browser extension host**: only one native host owns `run/browser-extension.sock` (`claimSocket` in `packages/browser-extension/host/native-host.mjs`); later hosts relay over stdio and never unlink or listen. `extension/background.js` reconnects with a timer backoff (`backoffDelay`, 1 s to 60 s); do not add `chrome.alarms`. The native host manifest `path` is the launcher written by `host/install-host.mjs --apply` (quoting in `host/launcher.mjs`). Branded Chrome 150 ignores `--load-extension`; the check loads the extension with `Extensions.loadUnpacked`.
- **Rail layout** (`overlay.layout: "rail"`, opt-in): the strip is the strut window (48 px) and the dock content appears in a panel beside it while expanded; geometry and the collapse decision are pure functions in `overlay_geometry.py` (`rail_rects`, `rail_expanded`, `rail_status`, `rail_words`). Rail Stop reuses `on_footer_click` and adds no trusted event. Check it with `python3 packages/app-overlay/runtime/rail_selftest.py` (nested Xephyr; exit 77 = skipped). `server.ts` treats `rail` like `dock` when it creates the timeline and action card.
- **Private bus for nested-display scripts**: AT-SPI's bus is a socket at `$XDG_RUNTIME_DIR/at-spi/bus_<display>`. A script that started its own accessibility services on your session shared that path, and when one exited it deleted the socket the real launcher still advertised, so every AT-SPI lookup failed (`label_not_found`, `accessibility_unavailable`, `see` falling back to OCR) until `at-spi-bus-launcher` was restarted. `check:live` and `benchmark:form` call `startPrivateBus()` (`scripts/private-bus.mjs`): own `dbus-daemon` and runtime dir, stopped and removed on exit. New scripts that open a nested display should do the same.
- **Stale X displays**: a killed nested X server leaves `/tmp/.X<n>-lock` behind.
  `check:live` ignores locks whose process is gone; do the same in new scripts.

- **Wayland portal (opt-in)**: `OSSEO_WAYLAND_PORTAL=1` on a Wayland session with no background display routes `desktop.click`, `type_text`, `hotkey` and `screenshot` through the RemoteDesktop and ScreenCast portals (`packages/os-linux/src/portal/`, helper `packages/os-linux/runtime/portal_helper.py`). `server.ts` builds a `PortalSession` and merges `createPortalDesktop` over the Linux adapter, as the Windows helper does. The first click, key press or screenshot asks the person once (reads such as the window context never do): one RemoteDesktop Start covers input and capture, and a refusal is kept for the process. The shared monitor is the one target (`portal-screen`); window listing and focus are refused, and pointer actions other than click and Teach waits are unavailable. The helper needs python3-gi (Gio and Gst) and GStreamer's `pipewiresrc`, `videoconvert` and `pngenc` or `jpegenc`. Not yet run on a real Wayland login (see `docs/notes/wayland-portal.md`).

- **Overlay cards need a compositor**: the GTK renderer needs `screen.is_composited()` for transparent cards (`overlay_compositor_unavailable`). A bare Xephyr test display reports `overlay_not_visible` for cards. To test cards on a nested display, run `gnome-shell --x11 --replace` on that display, on a private bus. Never run it on `:0`.

## Testing quirks

- Tests live in `__tests__/` dirs inside each package's `src/`
- `packages/os-linux/src/__tests__/portal-fake-bus.test.ts` runs the real portal helper against `portal/fake_portal.py` on a private `dbus-run-session` bus (skipped without dbus or gi). `portal-session.test.ts` uses a Python stand-in for the helper; `portal-desktop.test.ts` uses a fake session.
- Tests use Vitest (no separate config file; defaults from `vitest`)
- `packages/mcp-server/src/__tests__/action-overlay.test.ts` — automatic action card lifecycle, controls, persistence, auto-hide, and redaction
- `packages/app-overlay/src/__tests__/overlay-geometry.test.ts` — pure card/ring clamp, collision avoidance, and monitor selection
- `packages/mcp-server/src/__tests__/computer-tools.test.ts` — bounded condition waits and state snapshots
- `packages/mcp-server/src/__tests__/label-target.test.ts` — label resolution: exact names, ambiguity, disabled controls, window scoping, OCR fallback
- `packages/mcp-server/src/__tests__/set-field.test.ts` — read-back verdicts and set_field input rules
- `packages/mcp-server/src/__tests__/screenshot-registry.test.ts` — screenshot ids: expiry, bounds, point mapping
- `packages/mcp-server/src/__tests__/lean-output.test.ts` — lean and full result rendering, state sent once
- `packages/mcp-server/src/__tests__/guide-tools.test.ts` — guide.show/clear: placement, replacement, failures that show nothing, `guideActive`, `waitForClick`, Stop
- `packages/mcp-server/src/__tests__/view-registry.test.ts` — view ids, expiry, per-window replacement, stale windows, refusal codes
- `packages/mcp-server/src/__tests__/see.test.ts` — `see` line format, sources (accessibility, DOM, OCR), blocked fields, filter/max, picture modes, credential-app refusal
- `packages/mcp-server/src/__tests__/numbered-actions.test.ts` — each numbered action's nested tool and arguments, refusals, token pass-through
- `packages/mcp-server/src/__tests__/tool-profile.test.ts` — tool profiles: 14 default tools, full list, hidden tools still callable with a hint, resources follow the profile
- `packages/mcp-server/src/__tests__/see-e2e.test.ts` — built server over stdio, headless: 14 tools, then open a form, `see`, `type` and `click` by number in headless Chrome
- `packages/os-linux/src/__tests__/pointer-watch.test.ts` — pointer-press watcher: fake child cases and one real press on a nested display
- `packages/mcp-server/src/__tests__/screen-read.test.ts` — the text-free outline and its byte cap
- `packages/mcp-server/src/__tests__/see-diff.test.ts` — structure diff after numbered actions: sentence forms, sensitive fields, fallbacks, audit counts only
- `packages/mcp-server/src/__tests__/own-browser.test.ts` and `browser-extension-client.test.ts` — `browser.own_*` policy gate, refusals, allow-list file, framing against a fake socket
- `packages/mcp-server/src/__tests__/host-*.test.ts` and `packages/osseo-cli/src/__tests__/host.test.ts` — host socket, lease, protocol, shim, and an end-to-end run against the built host (skipped without a build)
- `packages/os-linux/src/__tests__/viewer-frames.test.ts` and `packages/osseo-cli/src/__tests__/viewer.test.ts` — viewer frame capture on a nested display; start/stop/status with the spawn stubbed
- `benchmarks/suite/__tests__/aggregate.test.ts` — suite aggregation (medians, rates, unverified counting). `vitest.config.ts` includes `benchmarks/suite/**`.
- `packages/mcp-server/src/__tests__/capability-catalog.test.ts` — the capability manifest equals the tools the server really registers (no `forge.*`, `policy.list_grants`)
- `packages/osseo-cli/src/__tests__/replay.test.ts` — session replay: grouping, outcomes, escaping, CSP, storage modes, prune limits
- `packages/browser-extension/src/__tests__/protocol.test.ts` and `content-refusals.test.ts` — native-host framing, host allow-list, refusal predicate copies compared
- `packages/mcp-server/src/__tests__/always-allow.test.ts` — chat "Always allow here": one rule written, next action needs no approval, refusals (any, navigate, unknown app, blocked, duplicate)
- `packages/mcp-server/src/__tests__/approval-overlay.test.ts` — approval card, the `always` event, and that the renderer treats `always` like `accepted`
- `packages/core/src/__tests__/policy-write.test.ts` — atomic writes, failed write leaves the old file, remove keeps comments
- `packages/osseo-cli/src/__tests__/policy-cli.test.ts` — `confirm --always`, `policy list|add|remove` (runs the built CLI; build first)
- `packages/mcp-server/src/__tests__/stdio-exit.test.ts` — the built server exits when stdin closes or on SIGHUP
- `packages/core/src/__tests__/workflow-expect.test.ts` — step expectation validation in saved workflows
- `packages/mcp-server/src/__tests__/task-overlay.test.ts` — automatic current-task card, checklist updates, pause/stop, and dismissal
- `packages/app-overlay/src/__tests__/task-progress.test.ts` — progress card states, controls, event routing, persistence and hide-marker handling
- `packages/app-overlay/src/__tests__/linux-renderer.test.ts` — GTK IPC, fallback, restart, event drain
- `packages/core/src/__tests__/capability-manifest.test.ts` — capability manifest tests
- Integration tests may require an X11 display (`:0`).

## Development workflow

Before major changes:
1. inspect repo
2. read `README.md` and `docs/INDEX.md`; treat older milestone docs as historical
3. summarize current state
4. propose exact files to create/edit
5. implement only approved milestone

After implementation:
1. show changed files
2. explain how to run
3. explain how to test
4. run build/test/lint
5. summarize next phase

## Existing instruction files worth preserving

- `.agents/skills/cavecrew/` — subagent delegation guide (investigator/builder/reviewer)
- `.agents/skills/caveman/` — ultra-compressed communication mode
- `.agents/skills/caveman-commit/` — compressed commit message generator
- `.agents/skills/caveman-compress/` — compress memory files to caveman format
- `.agents/skills/caveman-help/` — quick-reference card
- `.agents/skills/caveman-review/` — compressed code review comments
- `.agents/skills/caveman-stats/` — token usage stats
- `skills/osseo/SKILL.md` — portable laptop-control routing skill; installed by `scripts/install-osseo-skill.mjs` (keep the `.agents/skills/osseo/` copy in sync)
- `customize-opencode` skill — for opencode config changes only

## Important constraints from docs

- `overlay.assistance_target_refresh` validates ownership, kind, bounds, sensitivity, TTL; **two explicit refreshes maximum**
- Stale target or renderer epoch invalidates trust; requires explicit recovery
- Headless/Wayland fallback reports limitation instead of claiming unsupported coordinates
- Release scans reject credential-like material, token values, current-user absolute paths, screenshots/audio/logs, caches, runtime state, dangling dev symlinks, Python caches
- Uninstall preserves runtime data by default
- Progress cards persist after terminal states until explicit dismissal (Dismiss/Escape, `osseo overlay hide`, emergency hide, or process exit); elapsed time freezes
- Persistent overlays must be `sensitivity: "public"`; legacy `overlay.terminalAutoHideMs` is accepted and ignored
- `osseo overlay hide` writes `run/overlay.hide` (live managers poll it) and sweeps orphaned GTK renderers; `--orphans` only sweeps
- Overlay renderer PID files and temporary inspection scripts belong outside the repo; remove them after use

## Runtime

- MCP server entry: `packages/mcp-server/src/index.ts`
- Server entry: `packages/mcp-server/src/server.ts`
- Tool definitions in `packages/mcp-server/src/tools/`
