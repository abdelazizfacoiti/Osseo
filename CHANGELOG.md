# Changelog

## Unreleased

- Removed the Blender and SSH adapter packages, the `adapter.list` and `adapter.get` tools, and the adapter registry, because no tool was ever registered for them. An `optionalAdapters` key in an existing config file is still accepted and ignored.
- `agenthost integrations codex add` now also sets Codex's top-level `notify` so the terminal is raised when a turn ends. It never replaces a different `notify` program that is already set, and `remove` deletes only AgentHost's entry.
- The release build also writes `agenthost-linux-x64.tar.gz` (fixed name) with its checksum, which is the file `scripts/install.sh` downloads.
- One-line install: `curl -fsSL <url>/scripts/install.sh | sh` checks the SHA-256, installs the release archive under `~/.local` without `sudo`, and is safe to run twice. `--dry-run` changes nothing; `AGENTHOST_ARCHIVE` installs from a local file.
- Guide mode: `guide.show` draws highlight boxes with a text label (`Step 1 of 3`) on each place the person should click, placed by screen bounds, a screenshot rectangle, or a control label; `guide.clear` removes them. The agent never clicks. For apps it must not drive, or when the person asks to be shown how.
- Tooltip cards sit beside their target (right, left, below, then above) instead of in a screen corner, so a label can point at the place it describes. Other cards keep avoiding their target. Nothing in the product shows tooltips yet; this is the base for guide-mode steps.
- Claude Code raises the assistant's window when a turn ends (`Stop`), when Claude asks a question (`AskUserQuestion`), and when it sits idle waiting for you (`Notification` idle prompt). Re-run `agenthost integrations claude add --apply` to install the new hooks. `done` and `idle` do not pull focus back on the next tool call. Codex is not covered yet.
- The dock timeline opens only for approvals; done and idle do not reopen it.
- Dock layout by default: nothing floats over the work area. The action status is a bottom dock card (it stays until the task finishes, or hides 30 s after activity when there is no task). The floating pill, edge frame and target ring are off unless you enable them (`overlay.actionPill`, `overlay.frame`, `overlay.targetRing`). Verified actions no longer hide and redraw every card for each check, which was the flicker. Turning the pill, frame or ring back on restores the flicker.
- Task finished: when an explicit task completes or is cancelled, the action card, the dock history (Agent activity) and its frame and ring close, and the assistant's own window (the terminal or IDE running it) comes back to the front. Works where the process tree identifies that window, which is the Linux terminal or IDE case.
- The action card stays up between actions while an explicit task is open, instead of hiding 1.5 s after each action. Without a task it hides after `overlay.pillAutoHideMs` (default now 30 s, was 1.5 s).
- Approve in chat: when the client supports MCP elicitation (Claude Code does), a pending confirmation asks the person in the chat (`approvals.chat`, default on). Only the person can answer, never the agent. Yes lets the agent repeat the exact call with its token; No rejects it. The prompt shows the redacted preview, never the token. Cards and `agenthost confirm` keep working; clients without elicitation are unchanged.
- `browser.open` joins a Chrome that already owns the agent profile (an orphan from a killed server, or another session) in a new tab instead of failing after 15 s. Closing leaves that browser running.
- `screenChanged` is `null` (reason `window_still_changing`) when the window never settles (animation, video, blinking caret), instead of reporting a change that may be noise.
- `benchmark:form` closes its servers through stdin so Chrome does not outlive the run.
- Windows desktop adapter (`packages/os-windows`, W2 part 1): windows, screenshots, mouse, keyboard, clipboard and idle time through a PowerShell helper; focus drift re-activation; administrator windows refused as `elevated_window`. Accessibility tools are not available on Windows yet. Not yet run on a Windows machine: `scripts\windows-desktop-check.ps1`.
- `package-lock.json` lists the current packages again (it still named removed ones, so `npm ci` would have failed), and the release archive includes `os-windows`.
- Clipboard paste (`desktop.type_text`, `desktop.set_field`, `desktop.file_dialog_select`) restores the old clipboard only after the window stops changing, after a 350 ms minimum and capped at 1.5 s. The old fixed wait could restore too early in a slow app.
- Stop: an MCP server exits when its client closes stdin (or on SIGHUP), after closing its overlay cards. Before, a card renderer held the process open, so cards stayed on screen after the session ended.
- `desktop.click` takes a visible `label` (AT-SPI first, OCR fallback). Only exact names are clicked; disabled and ambiguous names are refused. The preview shows the resolved point, and an approved click is refused if that point moved.
- `desktop.set_field` sets a text field: it checks the field at the clicked point (refusing password fields, unexposed fields, and clicks that focus nothing editable), replaces or appends the text, and reads it back (`confirmed`). Empty text clears it.
- `desktop.file_dialog_select` picks a file in an open Open dialog by window id or title. It refuses Save dialogs. The path must pass the file read policy.
- Screenshot ids: `desktop.screenshot` names each capture. A click can name it with a point in the picture (`screenshotId`, `imageX`, `imageY`). The mapping is refused when the window moved or resized since the capture (`screenshot_stale`), or when the id expired.
- `returnScreenshot` (none, region, window) on click, type, hotkey, and set_field returns the settled picture inline with its own id.
- `screen.read` outlines the active window from the accessibility tree: names, enabled state, bounds, no text, capped in bytes.
- `output.verbosity` (default `lean`): compact results without server provenance, empty approval blocks, null fields, or a repeated state. `full` restores the previous output.
- `computer.run_steps` and saved workflows take `expect` per step (`screenChanged`, `windowTitle`, `textVisible`). A missed expectation stops the plan. The plan returns one line per step and an optional final picture (`returnScreenshot`).
- Browser: snapshots reach one level of same-origin iframes; clicks refuse disabled controls, and report `navigated` and `domChanged` (unknown when the page cannot be read). A click follows only a tab it opened.
- `npm run benchmark:form` runs one form task three ways (pixel before, pixel after, browser) and checks the gate: 50% fewer calls, 40% fewer bytes, no unverified successes. On this run: pixel-after is 53% fewer calls and 48% fewer bytes than pixel-before; the browser route is 68% fewer calls and 98% fewer bytes.

- Added `npm run check:live` (`scripts/live-check.mjs`): an end-to-end check of the build in a throwaway home, on a nested display and headless Chrome.
- Fixed: typing into a terminal did nothing after the paste-by-default change,
  because terminals ignore Ctrl+V. Paste now uses Ctrl+Shift+V in terminal apps
  (GNOME Terminal and other VTE apps) and Shift+Insert in xterm. Found by a live
  test against a real VTE terminal, which now runs in `npm run check:live`.
- Verified actions: `desktop.click`, `desktop.type_text`, and `desktop.hotkey`
  compare the window before and after the action and return
  `effect.screenChanged` (true, false, or null when the window could not be
  captured). Clicks hover the target first so hover styling is not read as a
  change. `verify: false` skips the check.
- Text entry pastes by default. Direct xdotool typing swapped W and Z on AZERTY,
  so it is no longer the default. Paste waits 350 ms before restoring the
  clipboard, which fixes the stale-paste race.
- `desktop.hotkey` accepts `repeat` (1-50, 20 ms apart). Modifier-plus-navigation
  chords such as `ctrl+End` never count as a loop.
- `desktop.screenshot` returns a downscaled JPEG inline (ffmpeg), so no second
  call is needed to read the file. `inline: false` turns it off.
- New browser tools: `browser.upload` (needs confirmation, file policy checked),
  `browser.select`, `browser.wait_for`, `browser.fill` (refuses sensitive fields
  before typing, reads values back), and `browser.screenshot` (inline image).
- Loop guard counts identical calls only within 60 seconds, and only when the
  screen state did not change. Repeat warnings say what to check.
- Budget and pause: `task.create` takes `maxActions`; verified progress (a new
  `task.update` phase or a verified criterion) resets the action count. A pause
  set by a guard keeps its card up and sends one persistent desktop notification
  with the resume command.
- `agenthost <command> --help` only prints usage and never changes state. Bare
  `agenthost agent resume` clears a pause and names any stop or takeover still
  active.
- Overlay failures are reported once per session instead of on every result. The
  dock keeps its reserved space for the session, so the target window no longer
  resizes after every idle gap.
- Wayland sessions that expose XWayland now work for X11 apps: window list,
  focus, type, click, screenshot, and the overlay cards (GTK runs with
  `GDK_BACKEND=x11`). Each result says it reaches XWayland windows only.
- Added `describeDesktopPlatform()` and a `desktopPlatform` section in
  `agenthost doctor`. On Windows and macOS, desktop tools now fail with
  `unsupported_platform` instead of a Linux error. See `docs/13_PLATFORMS.md`.
- Added `agenthost overlay check-input`: a harmless card to confirm that a real
  mouse or touchpad press is accepted by the Approve/Continue/Resume checks.
- Fixed a way around the approval cards: a process with `/dev/uinput` access
  could press Approve, Continue, or Resume with a virtual mouse. Those presses
  now require a device proven physical by its sysfs path. Stop and Pause are
  unaffected.
- Added `execution.placement: "background"`: a nested Xephyr display for all
  desktop work, so the person keeps their screen. It is also the supported path
  on Wayland, and the desktop layer now works without a window manager.
- Fixed desktop commands ignoring `context.env`, which would have sent
  nested-display actions to the real screen.
- Added `memory.save|search|delete` and `agenthost memory` for short how-to
  lessons; secrets are refused and results are marked untrusted.
- Added opt-in `notifications.pushUrl` for a generic phone alert. It cannot
  approve anything.
- Added opt-in phone approvals (`agenthost phone pair|status|unpair`): outbound
  polling of an ntfy-style channel, one-time codes stored only as hashes, and
  pairing gated by a terminal plus a real-pointer press. Previews go to the
  channel; see the risks in the V2 guide section 12b.
- Added `agenthost workflow list|show|run|delete` and
  `agenthost schedule list|add|remove`. A run goes through `computer.run_steps`
  and never approves anything itself (exit 2 when a step needs approval, 3 when
  halted); schedules are systemd user timers, previewed unless `--apply`.
- Added saved workflows (`workflow.save|list|get|delete`): a plan that worked is
  stored with named parameters and recalled instead of re-derived. They only
  store data; running one means passing the expanded steps to
  `computer.run_steps`, so every approval and safety gate still applies. Secrets,
  unknown tools, and agent/task control steps are rejected at save time.
- Added the `browser.*` tools (`open`, `snapshot`, `click`, `type`, `navigate`,
  `close`): a dedicated Chrome/Chromium profile driven over the DevTools
  Protocol with a built-in loopback WebSocket client (no new dependency).
  Elements are addressed by ref from a snapshot, not coordinates. Pages are
  classified by origin and path only, login/MFA pages are blocked and point at
  `agent.request_handoff`, password/one-time-code/card fields are never typed
  into, and clicks that pay, send, delete, or submit password/payment forms
  need an exact confirmation. Page text is marked `untrustedContent`.
- Added an "Approve this action?" card: pending confirmations can be approved or
  denied on screen, bound one-to-one to their token, with the redacted preview
  and no token shown. Control buttons (Approve, Deny, Continue, Pause, Resume,
  Stop) now ignore synthetic XTEST clicks by default
  (`overlay.allowSyntheticControl` to allow them).
- AgentHost now waits while the person is typing or moving the mouse before it
  injects input (`execution.yieldToUser`, default on), and fails with
  `user_active` instead of fighting for the cursor.
- A stuck loop (same call 10 times) or `execution.maxActionsPerTask` actions
  (default 500) now pauses the agent until the person presses Resume, instead
  of only adding guidance.
- Added `blockedApps` config: apps the operator never wants automated, treated
  like credential/security apps for input and reads.
- Results that carry screen, file, or clipboard text are marked
  `untrustedContent`, and the skill tells agents not to follow instructions in
  them.
- Removed `screenChangedHint` from state results: it compared screen geometry,
  not pixels, so it could never report a change.
- Added `agent.request_handoff` and a "Your turn" card for steps the agent must
  not do itself (login, MFA, CAPTCHA, payment). State-changing and
  screen-reading tools are refused until the human presses Continue (pointer
  only) or runs `agenthost agent resume --takeover`. `agent.status` and
  `agenthost agent status` report the handoff.
- Fixed the dock timeline growing over the task card and its Pause/Resume/Stop
  buttons. Card bodies now scroll while header and footer stay pinned, a pure
  `dock_layout` gives bottom cards priority and the timeline the remaining
  room, and the layout recomputes when a dock card is shown, updated, or
  dismissed. The dock also stays inside the monitor work area, clear of
  desktop panels.
- Timeline rows are reused in place (no flicker or spinner restarts), up to 40
  entries are shown, and repeated finished actions merge for display
  (`Click (5,6) ×3`, `Looked at screen ×N`). Failed, waiting, halted, and
  running entries never merge, and audit logs are unchanged.
- The task card now ends with a one-line summary (error and recovery counts)
  and the `agenthost task export` command.
- Added `agenthost integrations <client> add|status|remove` for opencode,
  Claude Code, Codex, Copilot (VS Code + CLI), and Cursor. `--apply` writes
  one server entry, preserves existing settings, and backs up an existing
  config. The
  skill installer now registers the MCP server for the same clients, and the
  skill can self-register when its tools are missing.
- Added an automatic persistent current-task card that shows the active goal,
  phase/current action, definition-of-done checklist, running-task count, and
  Pause/Resume/Stop. It restores the latest active task on startup and honors
  an explicit close.
- Fixed overlay buttons failing when multiple cards shared one manager: events
  are now routed per overlay instead of being drained by the first poller.
  Pause reasons are scoped, Stop failures are reported instead of shown as
  halted, and a stopped task card exposes Dismiss immediately.
- Fixed GTK renderer event polling overlapping an in-flight update, which
  could kill a healthy renderer and make the automatic task card disappear.
  Task-card Pause now requests the scoped global pause and shows Paused with a
  Resume control immediately.
- Approval waits now raise the action card and send a best-effort desktop
  notification to run `agenthost confirmations`; token values are never
  included.
- Added overlay Pause/Resume/Stop/Dismiss controls, raised approval cards, and
  task definition-of-done verification gates.
- Added fast task-decision guidance (inspect once, act, verify) and earlier
  duplicate-call nudges.
- Fixed release installs rewriting relative workspace symlinks to absolute
  temporary paths, which made the installed `agenthost start` fail with
  `ERR_MODULE_NOT_FOUND` and left MCP clients disconnected. Install now copies
  symlinks verbatim and rejects any symlink that escapes the install root.
- Replaced named policy profiles with one autonomous runtime policy. Routine
  local actions execute directly; external, destructive, private-data, and
  financial effects require exact confirmation. Removed
  `policy.get_profile` and `policy.list_profiles`, leaving 35 live tools.
- Added one automatic, public, click-through action card for every
  state-changing MCP tool, including waiting-for-approval, preview, done,
  halted, and error states.
- Added screenshot suppression so AgentHost cards never appear in captured
  screenshots.
- Enforced single-use, exact-preview confirmation tokens; active-task approval
  is limited to low/medium effects and only while the task is active.
- Enforced operator stop and human-takeover gates for state-changing tools,
  with redacted audit logging and repo-control-plane path protection.

## 0.1.0

- Minimal-v2 runtime: 37 MCP tools at release time in computer, filesystem, shell, desktop,
  vision/OCR, window, task, and agent-control families.
- Persistent task lifecycle with watch, export, pause/resume, and scoped
  approval commands.
- GTK3/X11 overlay renderer with task progress cards, pointer primitives, and
  cross-process hide/status handling.
- Linux release packaging, integrity scanning, Apache-2.0 licensing, and
  generated third-party notices.

No browser bridge, speech surface, scheduler execution, Control Room,
autonomous replay, remote listener, credential extraction, or hidden
background operation is included.
