# AgentHost MCP Tools and Adapter Specification

All callable tools return `ToolResult`. MCP transport is stdio. The current
minimal-v2 server exposes 67 base tools. This number is generated from the
loaded set at startup; treat `system.list_capabilities` and
`agenthost://capabilities` as authoritative instead of hard-coding counts.

Every loaded definition carries explicit execution metadata. Missing,
contradictory, or duplicate declarations fail registration. MCP `tools/list`,
`system.list_capabilities`, and the capability resources are projected from
the same loaded set.

State-changing `desktop.*`, `window.*`, `file.*`, and `shell.*` results also
carry a bounded top-level `state` snapshot when the backend can provide it:
active-window metadata, `windowChanged`, newly appeared windows, and a cheap
screen-change hint. `newlyAppearedWindows` lists only windows that were not
present before the call. Missing backend data is omitted rather than guessed.

## Inventory

### Observation and discovery

| Tool | Risk | Execution |
|---|---|---|
| `system.get_info` | observe | read_only |
| `system.list_capabilities` | observe | read_only |
| `system.check_dependency` | low | diagnostic |
| `adapter.list` | observe | read_only |
| `adapter.get` | observe | read_only |
| `computer.observe_state` | observe | read_only |
| `computer.wait_for` | observe | read_only |
| `computer.wait` | observe | read_only (fixed 50-10000 ms settle delay) |
| `ui.tree` | low | read_only (AT-SPI tree of an app or the active window) |
| `ui.find` | low | read_only (elements by name/role with screen bounds) |
| `screen.read` | low | read_only (text-free outline of the active window: roles, names, enabled state, bounds; capped in bytes, default 2048) |
| `guide.show` | low | metadata only (draws highlight boxes with text labels where the person should click; never clicks) |
| `guide.clear` | low | metadata only (removes the marks `guide.show` drew) |
| `clipboard.get` | medium | read_only + exact confirmation (clipboard may hold secrets) |
| `window.list` | low | read_only |
| `file.read` | low | read_only |
| `file.read_many` | low | read_only |
| `file.list` | low | read_only |
| `file.search` | low | read_only |
| `file.exists` | observe | read_only |
| `vision.analyze_image` | low | read_only |
| `vision.find_text` | low | read_only |
| `vision.find_text_on_screen` | low | read_only |
| `vision.find_target` | low | read_only |

### State-changing desktop and filesystem tools

| Tool | Risk | Execution |
|---|---|---|
| `computer.run_steps` | medium | state_changing (governed plan) |
| `desktop.screenshot` | medium | state_changing (routine; optional JPEG/region/scale) |
| `desktop.click` | medium | state_changing (routine; x and y, a visible `label`, or a point in a screenshot by `screenshotId`) |
| `desktop.pointer` | medium | state_changing (routine) |
| `desktop.hotkey` | medium | state_changing (routine) |
| `desktop.type_text` | medium | state_changing (routine) |
| `desktop.set_field` | medium | state_changing (routine; focuses a field by label or x and y, replaces or appends, reads it back; refuses password and unexposed fields) |
| `desktop.file_dialog_select` | medium | state_changing (routine; picks a file in an open Open dialog by window id or title; refuses Save dialogs; the path must pass the file read policy) |
| `window.focus` | medium | state_changing (routine) |
| `app.open` | low | state_changing (routine; desktop entry or executable) |
| `app.open_url` | low | state_changing (routine; http/https/file, optional browser new tab) |
| `ui.activate` | medium | state_changing (routine; accessibility action) |
| `ui.set_text` | medium | state_changing (routine; layout-independent text) |
| `clipboard.set` | low | state_changing (routine) |
| `file.write` | medium | state_changing (routine) |
| `file.ensure_dir` | medium | state_changing (routine) |
| `file.copy` | medium | state_changing (routine) |
| `file.move` | medium | state_changing (routine) |
| `file.delete` | high | state_changing + exact confirmation |
| `shell.run` | high (classifier may lower) | state_changing; high effects confirm |

### Browser (dedicated Chrome profile)

| Tool | Risk | Execution |
|---|---|---|
| `browser.open` | medium | state_changing (routine) |
| `browser.snapshot` | low | read_only (refs for controls in same-origin iframes, one level deep; `disabled`, `inFrame`, and redacted `value`) |
| `browser.click` | medium | state_changing (routine; pay/send/delete/submit controls need confirmation; disabled controls refused; reports `navigated` and `domChanged`) |
| `browser.type` | medium | state_changing (routine; password/OTP/card fields refused) |
| `browser.navigate` | medium | state_changing (routine) |
| `browser.close` | low | state_changing (routine) |
| `browser.upload` | high | state_changing (confirmed: exact preview and token) |
| `browser.select` | medium | state_changing (routine) |
| `browser.fill` | medium | state_changing (routine; sensitive fields refused before typing) |
| `browser.wait_for` | observe | read_only |
| `browser.screenshot` | low | read_only (inline JPEG) |

These drive a separate Chrome/Chromium profile (`~/.agenthost/browser/profiles/agent`)
over the DevTools Protocol on a loopback port, never the person's own profile.
Elements are addressed by ref from the latest `browser.snapshot`; a ref from an
older snapshot fails with `stale_ref`. Safety evaluates the page's origin and
path (never the query string). Login, MFA, and other security pages are
blocked and the result points the agent at `agent.request_handoff`.

`browser.fill` checks every field before typing any of them, then reads each
value back and reports which fields took the text. `browser.upload` attaches
files through the DevTools protocol without a file dialog; an upload is always
high risk, so it needs an exact confirmation, and each path must be absolute,
a regular file, and pass the file policy. `browser.wait_for` polls for text or
the URL instead of a fixed sleep.

### Agent control and tasks

| Tool | Risk | Execution |
|---|---|---|
| `agent.status` | observe | read_only |
| `agent.stop` | medium | metadata_only |
| `agent.takeover_begin` | medium | metadata_only |
| `agent.request_handoff` | medium | metadata_only |
| `task.create` | low | metadata_only |
| `task.status` | observe | metadata_only |
| `task.list` | observe | metadata_only |
| `task.update` | low | metadata_only |
| `task.update_status` | low | metadata_only |
| `task.add_event` | low | metadata_only |
| `workflow.save` | low | metadata_only |
| `workflow.list` | observe | metadata_only |
| `workflow.get` | observe | metadata_only |
| `workflow.delete` | low | metadata_only |
| `memory.save` | low | metadata_only |
| `memory.search` | observe | metadata_only |
| `memory.delete` | low | metadata_only |

Saved workflows are recalled plans, not a second way to execute. `workflow.save`
stores up to 20 steps (max 100 workflows) under `~/.agenthost/workflows/` with
`{{param}}` placeholders; it rejects unknown tools, `agent.*`/`task.*`/
`workflow.*`/`computer.run_steps` steps, undeclared or unused parameters, and
anything that looks like a secret. `workflow.get` returns the steps with
parameters filled in and executes nothing: the agent passes them to
`computer.run_steps`, so plan approval, per-step safety, stop/takeover, and
audit apply as for any plan. Put `computer.wait_for` steps between actions to
verify each one landed. Parameter values are substituted into string values
structurally, so a value cannot add or change steps.

`task.create` starts a persistent task, accepts observable `definitionOfDone`
criteria (max 12), and clears any active task approval. Its guidance uses a
fast path: inspect once, act, then verify. The runner also nudges on the 3rd
and 6th identical call so the agent changes strategy instead of looping.
`task.update_status` supports `paused`, `active`, `completed`, and `cancelled`.
Completing a task that has criteria requires `verifiedCriteria` covering every
criterion; otherwise the call fails with `definition_of_done_unverified` and no
state changes. Verified criteria are logged as `verification` events.
Completed and cancelled tasks are terminal and clear active approval.

`agent.stop`, `agent.takeover_begin` and `agent.request_handoff` are not gated by the flags they set.
There is intentionally no MCP tool to resume or clear a stop/takeover; those
are operator-only CLI actions. Agent/task control tools are metadata-only so a
model can organize work or request a stop without minting action tokens.

## Execution and confirmation model

For every tool call the central runner performs, in order:

1. Zod schema validation; invalid input returns `invalid_input` and never
   reaches the handler.
2. Stop/takeover/pause gate for state-changing tools. A requested stop returns
   `emergency_stop_requested`; human takeover returns
   `human_takeover_active`; an operator pause returns `pause_requested`.
   Read-only observation remains available.
3. Effect preview resolution: actual target path, target fingerprint, risk,
   policy approval, and blocked reason. Previews never execute the action.
4. `dryRun: true` returns the preview. If the effect needs confirmation, it
   also mints a single-use token. Routine local actions return no token.
   No action is executed.
5. A non-dry call executes directly when no confirmation is required.
   Consequential calls without a token return `confirmation_required` plus the
   CLI command to approve them. An active task approval can auto-chain only
   low/medium effects for an active task; it creates and consumes the exact
   token server-side. High, external, destructive, private-data, and blocked
   effects still require explicit per-action confirmation.
6. The token is consumed atomically. It is bound to tool, canonical arguments,
   and target fingerprint. Tokens are single-use, expire after 15 minutes, and
   are rejected if the tool, arguments, or target changed.
7. The handler runs with `confirmationSatisfied` set only for an accepted exact
   confirmation. Handlers revalidate safety and return a `ToolResult`.
8. The runner writes one redacted JSONL audit entry with tool, risk, approval
   status, preview/confirmation status, duration, bounded phase timings, error
   code, and server version/entry path provenance. `timings` covers action-card
   wait, safety gate, preview, handler, audit preparation, and total; it contains
   numbers only, never arguments. Audit write failure does not turn a completed
   action into a second action.

Operator commands:

```bash
agenthost confirmations                 # list pending tokens
agenthost confirm <tokenId>            # approve one exact preview
agenthost deny <tokenId>               # reject one preview
agenthost task approve <taskId> [--max-risk low|medium]
agenthost task pause <taskId>
agenthost task resume <taskId>
agenthost agent status
agenthost agent pause [--reason text]
agenthost agent stop [--reason text]
agenthost agent takeover-begin [--reason text]
agenthost agent resume --stop|--takeover|--pause
```

`agenthost stop` kills an AgentHost-managed background process and writes the
stop flag. `agenthost agent pause` holds state-changing tools until
`agenthost agent resume --pause`. `agenthost task pause` marks an active task
paused and requests the same run pause with a task-scoped reason;
`task resume` clears only that reason. `agenthost agent stop` writes the run
flag and clears active task approval; it is the appropriate emergency stop when
the MCP process is owned by the client.

## Files and shell

On Windows the path policy and the shell classifier use Windows rules (drive
letters, UNC paths, `%NAME%`, PowerShell and cmd patterns). See
[the platforms doc](13_PLATFORMS.md#windows-headless-w1) for what is covered.

Read-only: `file.read`, `file.read_many`, `file.list`, `file.search`, `file.exists`. `file.list` supports bounded recursion; `file.search` returns matching paths and line numbers without file contents. Routine state-changing:
`file.write`, `file.ensure_dir`, `file.copy`, `file.move`. `file.delete`
requires an exact confirmation. `file.delete` is file-only; recursive
directory deletion is not exposed over MCP and a directory target returns
`directory_delete_unsupported`.

`shell.run` executes argv without an implicit shell. It never calls
`sudo`; control-plane paths, credential/browser-profile paths, wrapper
shells, inline interpreter code, metacharacters, destructive file commands,
and package/service changes are classified high or blocked. The handler
rejects attempts to override `PATH`, `HOME`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
`NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, or `ENV`.

AgentHost control-plane paths (`run/`, `logs/`, `setup/`, `tasks/approvals/`,
`config.json`, and the configured config/log paths) are protected:
reads are medium risk; writes and deletes are blocked. Shell commands that
touch those paths or invoke mutating `agenthost` commands are blocked.

## Desktop and vision

`computer.run_steps` executes up to 20 named tool calls with the same runner,
schema, policy, stop/takeover, audit, and execution gates. A confirmed plan
token covers only low/medium effects inside that exact plan fingerprint; high
effects still need their own single-use token, and nested plans are rejected.

`computer.wait_for` accepts active-window, window-appears, title, file, and/or screen conditions
and returns a timestamped snapshot plus a short state fingerprint on success or
timeout, so agents can replace fixed sleeps with one bounded wait.

`desktop.click`, `desktop.pointer`, `desktop.hotkey`, and `desktop.type_text`
accept either the backward-compatible `activeWindow` context or a `target`
selector (`windowId`, `appName`, `title`, or `pid`). A target is focused,
verified immediately before execution, and returns `focus_failed` if focus or
verification fails. `desktop.type_text` routes ASCII letters/digits/space
through `xdotool type` and other text through clipboard paste; install
`xclip` or `xsel` for non-ASCII input; clipboard paste saves and restores the
prior clipboard contents when the backend permits it. `window.focus` returns
`previousWindow` so focus can be restored and accepts the same `target`
selector.

`desktop.click` names its target one of three ways: `x` and `y`; a visible
`label` (with an optional `role`), resolved through AT-SPI inside the active
window with OCR as the fallback; or `screenshotId` with `imageX` and `imageY`, a
point in a picture that `desktop.screenshot` returned. A label must match
exactly: a disabled or ambiguous name is refused with its candidates listed, and
a near miss is listed as a suggestion, never clicked. A confirmed click lands
where it was previewed; if the control moved in between it is refused
(`target_moved`). A screenshot id is refused with `screenshot_stale` when its
reference window moved, resized, or lost focus, with `screenshot_unknown` when it
expired (five minutes), and with `image_point_outside` for a point outside the
picture.

`desktop.click`, `desktop.type_text`, `desktop.hotkey`, and `desktop.set_field`
accept `returnScreenshot`: `none` (the default), `region` (480x320 around the
point), or `window` (the active window). The settled picture comes back inline
with its own `screenshotId`, so the next click needs no separate screenshot.

`desktop.set_field` focuses a text field, selects its text (or moves to the end
with `replace: false`), pastes the new text, and reads the field back. It checks
the editable field at the clicked point before typing anything and refuses with
`field_not_exposed`, `field_not_focused`, `sensitive_field` (password fields, by
state or by role), or `accessibility_unavailable`. `confirmed` is `true` when
the field reads back exactly, `false` is an error (`readback_mismatch`), and
`"unknown"` means AT-SPI cannot read the field here. Empty text clears it.

`screen.read` outlines the active window from the accessibility tree: roles,
names, enabled state, and bounds, with no text content, capped in bytes. It is
the cheap answer to "what is on screen"; a window with no outline returns a hint
to take a screenshot.

`guide.show` is guide mode: it draws a highlight box and a text label (`Step 1 of 3`,
or `Tip` for one step) on each place the person should click. It never clicks. Use it
when the person asks to be shown how, or when the app is sensitive or blocked for
automation. Up to 8 steps; each is placed by screen `bounds`, by a rectangle in a
`desktop.screenshot` picture (`screenshotId` plus `imageX`, `imageY`, `imageWidth`,
`imageHeight`), or by a control `label` (accessibility tree only, with an optional
`role`). If any step cannot be placed, nothing is shown and the error names the step
(`screenshot_unknown`, `image_point_outside`, `label_not_found`, `label_ambiguous`,
`bounds_off_screen`). A new `guide.show` replaces the previous guide; `guide.clear`
removes it. `desktop.screenshot` does not show the marks, and while a guide is up,
window-only captures hide and restore the cards as usual. The overlay keeps marks at
most 300 seconds.

ASCII text shorter than 512 characters uses a zero-delay `xdotool type`; longer
or layout-unsafe text uses clipboard paste and fails explicitly when neither
`xclip` nor `xsel` is available. Screenshot results include bounded
`unchanged: true` when the requested output frame hash matches the prior frame
for the same capture key.

Any tool may carry bounded routine bookkeeping metadata as
`task: { phase?, currentAction? }`. The runner removes it before the handler
schema, updates the active task, and appends a redacted progress/observation/
error event. It never auto-completes a task or changes definition-of-done
verification rules.

`vision.analyze_image`, `vision.find_text`, `vision.find_target`, and
`vision.find_text_on_screen` use local Tesseract when available and return
bounded, redacted suggestions. The screen variant captures a fresh full-screen
image and returns absolute screen coordinates as suggestions only. They never
click or type. `desktop.screenshot` writes under
`~/.agenthost/screenshots/` unless `outputDir` is supplied, so it follows the
routine direct-execution path; high-risk or consequential effects still use
exact confirmation. Optional `format`, `quality`, `scale`, and `region` fields
support JPEG OCR captures, downscaling, and native `scrot -a` region capture;
post-processing requires `ffmpeg`, and unsupported combinations fail explicitly.

## MCP resources

The server exposes exactly three resources:

- `agenthost://capabilities` — live JSON inventory, families, and execution
  class counts.
- `agenthost://capabilities.md` — compact agent-facing brief generated from
  the same live inventory.
- `agenthost://status` — live stop/takeover/pause flags and the active task
  approval.

There is no `agenthost://skills` resource. Portable skill files are installed
on disk by `npm run skill:install`; they are not served over MCP.

For static config files (`AGENTS.md`, `CLAUDE.md`), paste
`agenthost capabilities --markdown`.

## Optional adapters

`packages/app-blender` and `packages/app-ssh` provide reviewed app/device
adapters. Enabling `optionalAdapters.blender.enabled` or
`optionalAdapters.ssh.enabled` registers adapter capabilities in
`system.list_capabilities`, but this minimal-v2 server does not currently
register a base MCP tool factory for `blender.run_python` or
`ssh.run_command`. They therefore do not appear in `tools/list` in this tree.
Any future tool factory must carry state-changing metadata and use the same
central runner, dry-run, confirmation, stop/takeover, and audit path.

## Removed product surfaces

Control Room, the Browser Bridge (paired browser extension), the extension-based
browser DOM tools, the runtime-activity service, workflow/scheduler/Forge tool
families, speech tools, and `task.execute_plan` are not registered in this
minimal-v2 tree (saved plans via `workflow.*` are live; they only store data). The `ui.*` accessibility tools and the `browser.*` tools for
AgentHost's own dedicated Chrome profile are live. Older
sections of documents that mention them are historical.

## Overlay lifecycle

Overlay is not exposed as MCP tools in minimal-v2. The server owns a
`VisualSurfaceCoordinator`; automatic action cards are selected by
`overlay.mode` (default `always`). `always` opens one public, click-through
card for computer-action tool families (`computer.*`, `desktop.*`, `window.*`,
`vision.*`, `file.*`, `shell.*`, plus optional `browser.*`, `blender.*`, and
`ssh.*`) and for every state-changing tool. `on_change` keeps the older
behavior of state-changing cards plus confirmation fallback. `off` disables
automatic cards. Mode only changes feedback; schema, risk, policy, stop,
preview/confirmation, execution, and audit enforcement stay identical.

The action card opens before preview/handler work and reports running,
waiting-for-approval, preview-ready, done, failed, or halted state in place.
Renderer prewarm starts with the MCP server unless mode is `off`; startup and
shutdown share orphan-renderer cleanup. A card show waits at most 150 ms for a
first paint in routine work, or 1.5 seconds while approval is required, then
continues in the background. Once visible, a fast card holds its terminal state
for at least 400 ms without delaying the handler. Cards honor
`overlay.persistent` / `overlay.autoHideMs`. A failed render is reported as
`overlay: "unavailable:<reason>"`, sends one rate-limited best-effort desktop
notification, and never fails the action. A failed Pause/Resume/Stop write is
shown as a warning instead of a false state. New `confirmation_required` results raise the action
card and send a best-effort desktop notification naming
`agenthost confirmations`; token values are never shown. Local scripts use
`createOverlayRenderer`, `OverlayManager`, and `TaskProgressOverlay` from
`packages/app-overlay`.

The server also keeps an automatic current-task card visible while a task is
active or paused, showing the goal, phase/current action, definition-of-done
checklist, running-task count, and Pause/Resume/Stop. It restores the most
recent active/paused task on startup (24h freshness) and updates from `task.*`
results. Without an explicit task, `always` mode shows an implicit
`Computer activity` card that tracks the latest computer action; creating a
real task replaces it, and a dismissed implicit card stays dismissed. Task
cards are persistent by default and remain after terminal states until
dismissed, `agenthost overlay hide` is run, or the process exits. Elapsed time
freezes at terminal transition. Task-card Pause requests the scoped global
pause and shows Paused with Resume immediately; Stop never kills an in-flight
tool call. `agenthost overlay hide` writes a timestamped `run/overlay.hide`
marker that only managers already running at that time honor, and sweeps
orphaned renderers. `agenthost overlay status`, `agenthost doctor`, and
`agenthost://status.lastActivity` report the effective `overlay.mode`, renderer
mode, the last `run/activity.json` record (including `started`, `visible`,
timeout, and error), plus the registered renderer, marker, and live renderer
count, so a silent headless fallback is visible. Screenshot capture temporarily removes and restores all overlay
surfaces so AgentHost UI is never embedded in a screenshot. `overlay.mode:
"off"` skips these automatic task/activity cards too; the explicit
`agenthost task watch <id> --overlay` card remains opt-in.

Multiple cards share one manager. Call `pollEvents(overlayId)`; unmatched
events stay buffered for the other card. Pause reasons are scoped so an
action-card resume does not clear a task-card pause (or vice versa).
