# AgentHost minimal-v2 — Features and Runtime Guide

> **Scope:** the live minimal-v2 tree, package version `0.1.0`. “v2” here means
> the current minimal-v2 architecture, not a published 2.x release. Historical
> documents mention removed or aspirational surfaces; this guide covers only
> what this tree actually registers and executes.
>
> The live MCP registry, `docs/03_MCP_TOOLS_AND_ADAPTERS.md`, and
> `docs/04_SECURITY_PERMISSIONS_AND_LOGGING.md` remain authoritative if this
> guide ever drifts from source.

## 1. What AgentHost is

AgentHost is a local, provider-agnostic MCP server that gives an AI agent
controlled access to a Linux workstation:

```text
MCP client / model
  -> stdio MCP server
  -> schema validation
  -> risk + policy + grants
  -> stop / takeover / pause gate
  -> effect preview and confirmation when required
  -> tool handler
  -> bounded ToolResult
  -> redacted audit log
```

It is not a browser extension, cloud service, daemon, or autonomous scheduler.
It is a foreground MCP runtime composed by the agent per task.

Primary design goals:

- Local-first and private by default.
- Provider-agnostic through MCP stdio.
- Observable behavior with on-screen cards.
- Exact confirmation for consequential actions.
- Honest failure reporting rather than false success.
- Operator control independent of the model.
- Application-agnostic core; app-specific code stays outside it.

## 2. Runtime architecture

```text
packages/
  core/          App-agnostic risk tiers, permissions, policies, types, stores
  mcp-server/    MCP server, tools, runner, resources, overlays, task state
  agenthost-cli/ Operator CLI
  app-overlay/   GTK3 renderer, overlay manager, task progress card
  os-linux/      Linux desktop, filesystem, shell, window, OCR backends
```

Architecture rules:

- `packages/core` stays application-agnostic.
- `packages/core` does not import Linux-specific implementations.
- App-specific adapters, if any are added, live outside core.
- Every tool passes through one central execution runner.
- `tools/list`, `system.list_capabilities`, and capability resources are
  projected from the same loaded tool set.

The strategy order is advisory cost guidance, not a capability boundary:

```text
app adapter -> official API -> CLI/script -> browser automation
-> accessibility -> local OCR/vision -> GUI input -> guide mode
```

The extension-based Browser Bridge and guide mode are not live surfaces in this
tree. Browser work uses the `browser.*` tools (a dedicated Chrome profile driven
over the DevTools Protocol) when Chrome or Chromium is installed, and ordinary
desktop automation otherwise. Accessibility tools
(`ui.tree`, `ui.find`, `ui.activate`, `ui.set_text`) are live and wrap AT-SPI.

## 3. Live surface

The current server exposes **67 base MCP tools** and **3 resources**.

Tool counts are generated from the loaded set at startup. The authoritative
source is always:

- MCP `tools/list`
- `system.list_capabilities`
- `agenthost://capabilities`
- `agenthost://capabilities.md`

### Tool inventory

| Family | Tools | Behavior |
|---|---|---|
| System | `system.get_info`, `system.list_capabilities`, `system.check_dependency` | Runtime/system information, live capability inventory, dependency availability |
| Computer observation | `computer.observe_state`, `computer.wait`, `computer.wait_for` | Active window snapshot, bounded sleep, and window-appears, title, file, and screen condition waits with state snapshots |
| Browser | `browser.open`, `browser.snapshot`, `browser.click`, `browser.type`, `browser.navigate`, `browser.close` | Dedicated Chrome profile over the DevTools Protocol: element refs, no coordinates; security pages blocked, sensitive fields refused, consequential clicks confirmed |
| Apps | `app.open`, `app.open_url` | Launch an application or open a URL in a browser |
| Clipboard | `clipboard.get`, `clipboard.set` | Read or set the clipboard (reads are private-data gated) |
| Accessibility | `ui.tree`, `ui.find`, `ui.activate`, `ui.set_text` | AT-SPI tree, search, activate, and set text; credential/security apps are blocked |
| Governed plans | `computer.run_steps` | Up to 20 nested governed calls with plan-scoped low/medium approval |
| Windows | `window.list`, `window.focus` | Enumerate windows; focus and verify by ID/app/title/PID |
| Desktop | `desktop.screenshot`, `desktop.click`, `desktop.pointer`, `desktop.hotkey`, `desktop.type_text` | Screenshot, click, pointer movement/scroll/drag, key chords, typing |
| Files | `file.read`, `file.read_many`, `file.list`, `file.search`, `file.exists`, `file.write`, `file.ensure_dir`, `file.copy`, `file.move`, `file.delete` | Bounded local file operations; recursive listing/search are bounded; file-only deletion |
| Shell | `shell.run` | Governed argv execution without an implicit shell |
| Vision | `vision.analyze_image`, `vision.find_text`, `vision.find_target`, `vision.find_text_on_screen` | Local OCR; fresh screen OCR returns absolute-coordinate suggestions |
| Tasks | `task.create`, `task.status`, `task.list`, `task.update`, `task.update_status`, `task.add_event` | Persistent task state and definition-of-done tracking |
| Workflows | `workflow.save`, `workflow.list`, `workflow.get`, `workflow.delete` | Saved, parameterized plans recalled instead of re-derived; executed only by passing the expanded steps to `computer.run_steps` |
| Memory | `memory.save`, `memory.search`, `memory.delete` | Short how-to lessons across sessions; no task content or secrets |
| Agent control | `agent.status`, `agent.stop`, `agent.takeover_begin`, `agent.request_handoff` | Runtime flags, emergency controls, and the human handoff |

### Execution classes

- `read_only`: observation and discovery.
- `diagnostic`: dependency checks.
- `metadata_only`: task and agent control records.
- `state_changing`: GUI, filesystem, shell, and window changes.

Missing or contradictory execution metadata fails server startup. Tool names
never infer execution class.

Every callable tool returns a `ToolResult`. Tool errors are recoverable data,
not terminal protocol failures. Successful and failed results can carry server
version and entry-path provenance from the live runtime.

## 4. Capability details

### Computer observation

`computer.observe_state` returns:

- Active window context.
- Screen geometry.
- Desktop backend and capability information.
- Optional visible-window list.

`computer.wait_for` polls active-window, any-window, and/or screen conditions
every ~150 ms until they match or the timeout expires. It returns a timestamped
state snapshot and short fingerprint on success or timeout, replacing fixed
sleeps with one bounded wait.

### Window control

`window.list` enumerates visible windows, optionally with titles. It uses a
short-lived cache to avoid repeated expensive enumeration.

`window.focus` supports window ID, app name, title, or PID. It:

- Returns the previous window when available.
- Verifies that focus actually changed.
- Falls back to `xdotool windowactivate --sync`.
- Fails with `focus_failed` if focus cannot be established.

### Desktop automation

All GUI input tools require explicit active-window context and validate it
immediately before execution.

| Tool | Capability |
|---|---|
| `desktop.click` | Left/middle/right click at absolute coordinates, on a visible label (AT-SPI, then OCR), or at a point in a returned screenshot (`screenshotId`) |
| `desktop.hotkey` | One or more key combinations |
| `desktop.type_text` | Up to 10,000 characters into the active window |
| `desktop.set_field` | Sets a text field by label or coordinates: focuses it, replaces or appends, and reads it back (`confirmed`); refuses password fields and clicks that focus no editable field |
| `desktop.file_dialog_select` | Picks a file in an open Open dialog (by window id or title); refuses Save dialogs; the path must pass the file read policy |
| `screen.read` (observation) | Text-free outline of the active window from the accessibility tree, capped in bytes |
| `desktop.pointer` | Pointer movement, scrolling, and drag primitives |
| `desktop.screenshot` | Full-screen, active-window-only, or region PNG/JPEG capture with scale/quality |

Typing behavior:

- ASCII letters, digits, and spaces use `xdotool type`.
- Other text uses clipboard paste.
- Clipboard paste saves and restores the prior clipboard contents when the
  selected backend supports both operations.
- Missing clipboard tooling produces an explicit failure instead of mistyped
  input.

Screenshot behavior:

- Creates output directories with mode `0700`.
- Removes stale output first.
- Rejects missing, empty, or zero-byte captures.
- Suppresses AgentHost overlays during capture and restores them afterward.
- Supports optional `region`, `scale`, `format: "jpeg"`, and `quality`; native
  `scrot -a` region capture avoids post-processing, while crop/scale/JPEG
  conversion requires `ffmpeg` and fails explicitly when unavailable.
- Returns image dimensions and capture options in `screenshotMetadata` when
  readable.

Desktop backends report unsupported or failed actions explicitly. A tool does
not report success unless the backend confirms that the action was performed.

Targets and pictures:

- A click names one target: `x` and `y`, a visible `label` (exact match, AT-SPI
  first, OCR second), or `screenshotId` with `imageX` and `imageY`. Disabled and
  ambiguous labels are refused; a near miss is listed, not clicked.
- A screenshot id maps picture points to the screen. It is refused when the
  reference window moved, resized, or lost focus (`screenshot_stale`), when it
  expired after five minutes (`screenshot_unknown`), or when the point is outside
  the picture (`image_point_outside`). Twenty pictures are kept.
- Click, type, hotkey, and set_field accept `returnScreenshot` (`none`, `region`,
  or `window`). The picture comes back inline with its own id.
- An approved click is refused (`target_moved`) when its control moved between
  the preview and the click. The preview shows the resolved point.
- A failure to make a picture never fails the action it follows.

### Vision and OCR

Vision tools operate on approved local images only:

- Default approved sources: AgentHost screenshots and outputs.
- Other paths require a matching grant.
- Maximum image size: 20 MB.
- Formats: PNG, JPEG, WebP, BMP, TIFF.
- Local Tesseract OCR only; no upload or cloud OCR.
- Credential/security windows are blocked.
- Communication-app images are treated as sensitive.

Capabilities:

- `vision.analyze_image`: bounded redacted OCR text boxes.
- `vision.find_text`: locate OCR text.
- `vision.find_text_on_screen`: fresh OCR with absolute screen-coordinate suggestions; never clicks.
- `vision.find_target`: rank target suggestions with image-relative
  coordinates.

Vision never clicks or types. Repeated OCR on the same image reuses cached
results. Coordinates are image-relative and remain suggestions until validated
and acted on through a governed desktop tool.

### Filesystem

Read-only:

- `file.read`
- `file.read_many`
- `file.list` (optional bounded recursion)
- `file.search` (paths and line numbers only)
- `file.exists`

Routine state-changing:

- `file.write`
- `file.ensure_dir`
- `file.copy`
- `file.move`

Consequential:

- `file.delete` requires a single-use confirmation.
- Directory deletion is not exposed.
- A directory target returns `directory_delete_unsupported`.

Default write roots are `~` and `/tmp`; exact per-path decisions come from the
safety evaluator. AgentHost control-plane files are write/delete blocked.

### Shell

`shell.run` executes command + argv without an implicit shell.

Features:

- Timeout: 100 ms to 5 minutes.
- Bounded output.
- Filtered environment.
- Rejects overrides of `PATH`, `HOME`, `LD_PRELOAD`, `LD_LIBRARY_PATH`,
  `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, and `ENV`.
- Classifies destructive commands, wrapper shells, inline interpreters,
  package/service changes, credential paths, and protected control-plane
  access.
- `sudo`, unsafe metacharacter patterns, and mutating AgentHost control
  commands are blocked.

High-risk shell effects require exact confirmation. Some lower-risk commands
may execute directly.

## 5. Safety and confirmation model

AgentHost has one autonomous runtime policy.

Risk levels are `observe`, `low`, `medium`, `high`, and `blocked`.

### Routine local actions

These execute directly:

- GUI click, type, hotkey, pointer.
- Window focus.
- Screenshots.
- Routine file writes, copies, moves, and directory creation.
- Classified-safe shell commands.

### Consequential actions

These require an exact preview and single-use confirmation token:

- Destructive actions.
- External sends/uploads.
- Private-data access.
- Financial or communication effects.
- High-risk effects.

### Blocked actions

These remain denied even with a valid token:

- Credential and security apps, and any app listed in config `blockedApps`
  (case-insensitive substring of app id, name, or URL; applies to input and to
  `ui.*`/`vision.*` reads).
- Secret data.
- Protected system paths.
- AgentHost control-plane writes and deletes.
- Actions blocked by policy or grants.

### Dry-run envelope

A consequential tool accepts:

```json
{ "dryRun": true }
```

This returns:

- Resolved target.
- Target fingerprint.
- Risk level.
- Policy decision.
- Blocked reasons.
- A token when confirmation is required.

Nothing executes.

### Token properties

- Valid for 15 minutes.
- Single use.
- Stored under `~/.agenthost/run/confirmations/` with mode `0600`.
- Bound to:
  - tool name;
  - canonical arguments;
  - target fingerprint.
- `dryRun` and `confirmationToken` are excluded from the argument binding.
- Changed tool, arguments, or target causes a mismatch.
- Tokens are not session-bound because MCP clients may launch a fresh server
  process per call.
- The runner claims and consumes a token atomically before the handler runs.
- Handlers revalidate safety with `confirmationSatisfied` only after an
  accepted exact confirmation.

Operator commands:

```bash
agenthost confirmations
agenthost confirm <tokenId>
agenthost deny <tokenId>
```

### Approving from the screen

Each pending confirmation created by the running MCP server also appears as an
"Approve this action?" card with the redacted preview, tool, risk, and expiry,
plus Approve and Deny buttons. Cards are shown one at a time (oldest first)
and each is bound to its own token, which is never displayed. Approve and Deny
make exactly the decision `agenthost confirm|deny` makes; they do not run the
action, the agent still retries with its token.

Control buttons (Approve, Deny, Continue, Pause, Resume, Stop) are accepted
only from a real pointer or touch device. The renderer ignores keyboard and
accessibility activation, input AgentHost injects itself, and synthetic XTEST
clicks (for example `xdotool` run through `shell.run`), which GTK reports as
`Virtual core XTEST pointer`.

Approve, Continue, and Resume grant something, so they must also come from
provably physical hardware. A process with `/dev/uinput` access can create a
mouse with any name, so the renderer ignores names: it resolves the event's
device through `xinput list-props` to its evdev node and refuses anything under
`/sys/devices/virtual/input/`, where the kernel places every uinput device. If
this cannot be proven (`xinput` missing, no device node) the press is ignored
and the CLI is the fallback. Stop and Pause skip this check, because they only
halt the agent and must always work.

Known limits: clients that start a fresh server process per call may not show
cards for tokens made by another process. A process that can write
`/dev/input/event*` for a real device, which needs the `input` group or root,
could still inject through that device. Remote-desktop or on-screen-keyboard users
can set `overlay.allowSyntheticControl: true`, which turns these checks off.

### Active task approval

```bash
agenthost task approve <taskId> [--max-risk low|medium]
```

- Valid for 30 minutes.
- Only for an active task.
- Only covers low/medium effects.
- The runner creates and consumes the exact token server-side.
- High, destructive, external, private-data, and blocked effects still require
  per-action confirmation.
- Creating, completing, or cancelling a task clears approval.
- Stop and takeover clear approval.
- Paused, completed, cancelled, missing, or expired tasks do not get auto-chain.

### Plan approval

`computer.run_steps` accepts up to 20 named tool calls. Its own preview is bound
to the exact plan fingerprint, and a confirmed plan token covers only the
low/medium effects inside that exact plan:

- Every nested call still re-enters schema, policy, runtime gates, safety
  preview, audit, and execution metadata.
- High-risk steps still need their own per-step token.
- Preview-only nested calls never mint, consume, or log a token.
- Nested `computer.run_steps` calls are rejected.
- Stop/pause/takeover is rechecked after the state-changing execution lane is
  acquired.
- A step may carry `expect` (`screenChanged`, `windowTitle`, `textVisible`),
  checked from the step's own result and the window afterwards. A missed
  expectation stops the plan, even with `stopOnError` off; a check that cannot be
  made is reported as `expectation_unverified`, never as a pass.
- `returnScreenshot` on the plan returns one picture after the whole plan. The
  result lists one line per step.

### Grants

Persistent grants are validated and scoped by capability. A grant can restrict
or allow specific tools, action types, apps, sensitivities, file roots,
commands, and related bindings. It does not replace a confirmation token for a
high-risk, external, destructive, or private-data effect.

The default policy includes one communication-read grant allowing observation
and reads up to medium risk. Sends and external effects remain
confirmation-gated.

## 6. Tasks and definition of done

Tasks are persistent records under `~/.agenthost/tasks/`.

### Lifecycle

1. `task.create` with a goal and up to 12 observable `definitionOfDone`
   criteria.
2. `task.update` changes phase and current action.
3. `task.add_event` records:
   - `progress`
   - `observation`
   - `error`
   - `recovery`
   - `verification`
   - `note`
4. `task.update_status` supports:
   - `active`
   - `paused`
   - `completed`
   - `cancelled`

Completion with criteria requires `verifiedCriteria` to cover every criterion.
Otherwise:

- The task is not changed.
- `definition_of_done_unverified` is returned.
- Missing criteria are listed.

Verified criteria become `verification` events.

Completed and cancelled tasks are terminal and clear active task approval.

### Anti-loop behavior

The runner tracks identical calls for non-control tools within a 60-second
window, and only when the screen state did not change between them. It adds
guidance on the 3rd and 6th identical call to check the result or change
approach.

Two guards actually pause the agent (a scoped pause the action card can
Resume, reason prefix `agent_action_card_pause:`), because guidance alone does
not stop a runaway loop:

- The same state-changing call repeating 10 times in a minute with no visible
  change (then again every 5). Modifier-plus-navigation chords such as
  `ctrl+End` never count.
- `execution.maxActionsPerTask` successful state-changing actions since the last
  progress update (default 500; `0` disables). `task.create` takes its own
  `maxActions`. A new `task.update` phase or a verified criterion resets the count.
  A pause set by a guard keeps its card up and posts one persistent desktop
  notification with the resume command.

### Human-aware execution

- **Yield to the user.** Before injecting input (`desktop.click`,
  `desktop.pointer`, `desktop.hotkey`, `desktop.type_text`, `ui.activate`,
  `ui.set_text`) the runner reads X idle time. If the person touched the
  keyboard or mouse in the last 1.2 s and it was not AgentHost's own injection
  (compared with the `run/input-active` marker), it waits up to 15 s, then
  fails with `user_active` and sends nothing. Disable with
  `execution.yieldToUser: false`. It needs the XScreenSaver extension
  (`libXss`); when idle time is unreadable it never blocks.
- **Untrusted content.** Results of OCR, `ui.*`, file reads, and clipboard reads
  carry `untrustedContent: true` and an observation telling the agent to treat
  the text as data, not instructions.

## 7. Agent control and operator authority

### MCP tools

- `agent.status`: stop, takeover, pause, active task approval, server
  provenance.
- `agent.stop`: writes the emergency-stop flag and clears active task approval.
- `agent.takeover_begin`: marks human takeover and clears active task approval.
- `agent.request_handoff`: asks the human to do a login, MFA, CAPTCHA, or
  payment step. It raises the takeover flag and writes `run/handoff.active`.
  While active, state-changing tools halt and screen-reading tools
  (`desktop.screenshot`, `vision.find_text_on_screen`, `ui.tree`, `ui.find`,
  `clipboard.get`, `computer.wait_for`, `computer.observe_state`) fail with
  `handoff_active`. A "Your turn" card with a pointer-only Continue button, or
  `agenthost agent resume --takeover`, ends it.

Neither stop nor takeover is gated by the flag it sets, so the agent can request
them safely.

There is intentionally **no MCP tool to resume**. Only the operator can clear
stop, takeover, or pause from the CLI.

### Enforcement

The runner checks:

- `run/stop.requested`
- `run/takeover.active`
- `run/pause.requested`

These gates apply to state-changing tools only. Observation remains available.

### CLI controls

```bash
agenthost agent status
agenthost agent pause [--reason text]
agenthost agent stop [--reason text]
agenthost agent takeover-begin [--reason text]
agenthost agent resume --stop
agenthost agent resume --takeover
agenthost agent resume --pause
```

Flags can be combined when clearing multiple gates.

## 8. Overlay and visual behavior

The overlay is not exposed as MCP tools. The server owns it internally.

### Modes

| Mode | Behavior |
|---|---|
| `always` | Cards for computer-action families and state-changing tools; implicit activity card |
| `on_change` | Cards only for state-changing actions plus confirmation fallback |
| `off` | No automatic action or task cards; explicit `task watch --overlay` still works |

Computer-action families:

- `computer.*`
- `desktop.*`
- `window.*`
- `vision.*`
- `file.*`
- `shell.*`
- `browser.*`

### Action card and ambient layers

- Opens before preview/handler work.
- Compact top-center pill by default, showing state, tool/step, risk, and the
  summary; approval waits expand with warning text and controls.
- Shows running, waiting, preview-ready, done, failed, or halted state.
- Ambient frame: thin screen-edge border, blue while running, amber while an
  operator decision is pending, red after failure, green after success.
- Target ring: for `desktop.click` and `desktop.pointer`, a small ring marks
  the exact target for roughly 600 ms with a 150 ms pre-action lead. The ring
  is best-effort and never changes the action.
- Frame and ring motion use Cairo when available and GTK CSS fallbacks
  otherwise; `reducedMotion` keeps both static.
- Click-through except small control windows; Pause/Resume/Stop and Dismiss
  remain interactive.
- Waits at most 150 ms for first paint in routine work, or 1.5 seconds on
  approval waits, then continues in the background.
- Holds a fast visible card for at least 400 ms; the handler already finished.
- Done pills fade after `overlay.pillAutoHideMs` (default 1.5 s). Failed,
  paused, halted, and approval cards stay visible until the next action or an
  explicit dismissal.
- Never blocks execution if rendering fails.
- Reports `overlay: "unavailable:<reason>"` and sends one rate-limited
  best-effort desktop notification when the card cannot render.
- Raises on approval waits and sends one best-effort desktop notification.
- Never displays confirmation-token values.
- Honors `overlay.persistent` and `overlay.autoHideMs` for the full task card.
- Ambient mode is the default. `overlay.layout: "dock"` reserves a 20% sidebar
  (left or right) through an X11 `_NET_WM_STRUT_PARTIAL`; other windows use the
  remaining work area. Dock mode is opt-in because it changes desktop layout
  and can invalidate coordinates captured before it was enabled. It requires
  `xprop`; the background is click-through, and screenshot suppression still
  hides AgentHost cards.

### Current-task card

Shows:

- Goal.
- Phase/current action.
- Definition-of-done checklist.
- Running-task count.
- Elapsed time.
- Pause/Resume/Stop.
- Latest error/recovery summary.

Behavior:

- Restores the most recent active/paused task on startup within 24 hours.
- Without a real task, `always` mode shows an implicit “Computer activity” card.
- Creating a task replaces the implicit card.
- Dismissal sticks for that card.
- Terminal cards remain until dismissed.
- Elapsed time freezes at terminal state.
- Pause requests a task-scoped global pause.
- Stop does not kill an in-flight tool call.
- `overlay.mode: "off"` skips automatic task and activity cards.

### Diagnostics and cleanup

`run/activity.json` records the last action card:

- Started state.
- Visible state.
- Timeout state.
- Error.

Surfaced by:

- `agenthost overlay status` (including effective overlay/renderer mode)
- `agenthost doctor`
- `agenthost://status.lastActivity`

`agenthost overlay hide` writes a timestamped cross-process hide marker that
only already-running managers honor, and can sweep orphaned GTK renderers.
`agenthost overlay hide --orphans` only sweeps.

The renderer prewarms with the server unless overlay mode is `off`; startup and
shutdown also sweep orphaned renderers. On X11,
transparent, topmost, click-through surfaces are used when the compositor
supports them. Wayland, headless, or unavailable renderers report limitations
instead of claiming visible success.

## 9. MCP resources

Exactly three resources:

| Resource | Purpose |
|---|---|
| `agenthost://capabilities` | Live JSON inventory, execution classes, families |
| `agenthost://capabilities.md` | Compact agent-facing capability brief |
| `agenthost://status` | Stop/takeover/pause, active task approval, last activity overlay state |

There is no skills resource. The portable skill is installed on disk.

For static agent configs, prefer `agenthost://capabilities.md` or
`agenthost capabilities --markdown` instead of ingesting every tool schema on
every turn.

## 10. CLI features

### Saved workflows and schedules

```bash
agenthost workflow list
agenthost workflow show <name>
agenthost workflow run <name> [--param key=value ...] [--unattended]
agenthost workflow delete <name>
agenthost schedule list
agenthost schedule add <name> (--daily HH:MM | --weekdays HH:MM | --every 30m|2h) [--param k=v ...] [--apply]
agenthost schedule remove <name> [--apply]
```

`workflow run` loads a saved workflow (see `workflow.save`), fills in the
parameters, and runs it through the real `computer.run_steps` tool in a fresh
server context with `stopOnError`, so every approval, safety, stop, pause, and
takeover gate applies. It never approves anything itself. Exit codes: `0`
completed, `1` failed, `2` stopped because a step needs an exact confirmation
(run `agenthost confirmations`), `3` halted by stop/pause/takeover, a handoff,
or because the user was active. `--unattended` also sends a desktop
notification when a run does not complete.

`schedule add` previews by default; `--apply` writes a systemd user
`agenthost-wf-<name>.service` and `.timer` and enables the timer. Parameters sit
in a plain-text unit file, so values that look like secrets are refused. The
unit captures `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`,
`XDG_RUNTIME_DIR`, and the AgentHost home at creation time; re-run `schedule add
--apply` if your session changes. AgentHost still runs no daemon of its own:
systemd starts a one-shot process per run.

### Setup and diagnostics

```bash
agenthost version
agenthost doctor [--json]
agenthost setup [--resume]
agenthost config show
agenthost config validate
```

`doctor` checks platform, architecture, Node, Python, X11, GTK/PyGObject, MCP
entry, MCP handshake, client config, storage, process state, and last activity.

`setup` is local, resumable, and does not install system dependencies
automatically.

### Runtime lifecycle

```bash
agenthost start
agenthost stop
agenthost status
agenthost sessions
```

`start` runs in the foreground. `start --background` is rejected. There is no
daemon, systemd unit, cron job, or restart loop.

`stop` writes the stop flag and terminates an AgentHost-managed background
process if one exists.

### Tasks

```bash
agenthost task list
agenthost task status <id>
agenthost task pause <id>
agenthost task resume <id>
agenthost task stop
agenthost task approve <id> [--max-risk low|medium]
agenthost task watch <id> [--follow] [--notify] [--overlay]
agenthost task export <id> [--format md|html] [--out <path>]
```

`task watch` tails redacted events. `task export` creates a shareable redacted
report.

### Discovery and permissions

```bash
agenthost capabilities
agenthost capabilities --markdown
agenthost permissions
```

### Overlay

```bash
agenthost overlay status
agenthost overlay hide
agenthost overlay hide --orphans
```

### Integrations

```bash
agenthost integrations status
agenthost integrations <client> add [--apply]
agenthost integrations <client> remove [--apply]
```

Supported clients:

- `opencode`
- `claude`
- `codex`
- `copilot`
- `copilot-cli`
- `cursor`

Preview is the default. `--apply` writes one entry, preserves unrelated config,
and backs up existing files. Reload or restart the client afterward so it
spawns AgentHost.

Two clients also get attention hooks that raise the agent's terminal through
`agenthost attention request`: `claude` gets Claude Code hooks in
`~/.claude/settings.json` (permission prompts, questions, turn end), and
`codex` gets a top-level `notify = ["agenthost", "attention", "request",
"--source", "codex", "--reason", "done"]` in `~/.codex/config.toml`, which Codex
runs when a turn ends. Codex allows one `notify` program, so an existing one
that is not AgentHost's is left unchanged and reported in `codexNotify`
(`configured: false` with a reason). `status` reports whether AgentHost's is
present and `remove` deletes only that one.

### Update and uninstall

```bash
agenthost update --archive <archive> [--sha256 <digest>] [--apply]
agenthost update --rollback [--apply]
agenthost uninstall [--dry-run] [--yes] [--remove-data]
```

Updates require checksum verification, preflight, backup, atomic switch, and
rollback support. Uninstall preserves runtime data by default.

## 11. MCP client integration and portable skill

Any MCP client can use:

```json
{
  "mcpServers": {
    "agenthost": { "command": "agenthost", "args": ["start"] }
  }
}
```

Known integration config locations:

| Client | Config |
|---|---|
| `opencode` | `~/.config/opencode/opencode.json[c]` under `mcp` |
| `claude` | `~/.claude.json` under `mcpServers` |
| `codex` | `~/.codex/config.toml` under `[mcp_servers.agenthost]` |
| `copilot` | `<project>/.vscode/mcp.json` under `servers` |
| `copilot-cli` | `~/.copilot/mcp-config.json` under `mcpServers` |
| `cursor` | `<project>/.cursor/mcp.json` under `mcpServers` |

`XDG_CONFIG_HOME`, `CODEX_HOME`, and `COPILOT_HOME` override default config
roots. Invalid JSON/TOML, ambiguous TOML, and unsupported layouts are rejected
without writing.

Portable skill installation:

```bash
npm run skill:install -- --target all
npm run skill:install -- --target all --no-mcp
npm run skill:install -- --print
```

The skill teaches an assistant when to route laptop-control work through
AgentHost. `--no-mcp` installs skill text only.

## 12. Configuration

AgentHost loads one strict JSON config with `schemaVersion: 1`.

Main fields:

| Field | Purpose |
|---|---|
| `agentHostDir` | Runtime data directory |
| `logFile` | Audit log path |
| `overlay` | Renderer mode, activity mode, theme, density, persistence, placement, width, monitor policy |
| `execution` | `placement` (`foreground` default, `background` nested display), `yieldToUser` (default true), `maxActionsPerTask` (default 500; 0 = off) |
| `notifications` | `pushUrl`: optional generic phone alert (https); never approves |
| `output` | `verbosity`: `lean` (default: compact results without server provenance, an empty approval block, or null fields; the state is sent once and then `stateUnchanged`) or `full` (every field, pretty-printed) |
| `blockedApps` | Apps the operator never wants automated (substring match) |
| `grants` | Capability-scoped allow/deny/guide-only rules |
| `optionalAdapters` | Ignored. Old config files that still contain it load without error |

Overlay fields include:

- `rendererMode`
- `mode`
- `theme`
- `density`
- `reducedMotion`
- `persistent`
- `autoHideMs`
- `preferredPosition`
- `maxWidth`
- `multiMonitor`
- `layout` (`ambient` default, or `dock`)
- `dockSide` (`left` or `right`)
- `dockWidthPercent` (10–40; default 20)
- `dockReserveSpace` (default true)
- `frame` (default true)
- `actionPill` (default true)
- `targetRing` (default true)
- `targetRingLeadMs` (0–600; default 150)
- `targetRingDurationMs` (200–2000; default 600)
- `pillAutoHideMs` (0–30000; default 1500; 0 keeps done pills)

Renderer modes include `auto`, `gtk3-native` (`gtk3-x11` alias), `headless`, and
`disabled`. `webkit-gtk-react` is diagnostic-only. Wayland and missing GTK3
dependencies report limited or unavailable visibility rather than claiming
visible success.

Documented environment overrides:

- `AGENTHOST_HOME`
- `AGENTHOST_CONFIG`
- `AGENTHOST_LOG_FILE`
- `AGENTHOST_OVERLAY_MODE`

`AGENTHOST_PROFILE` is ignored. Legacy settings may be accepted for
configuration compatibility, but they do not register removed tools. Removed
top-level config keys such as `runtimeActivityOverlay`, `browserBridge`,
`controlRoom`, and `profile` are stripped before strict validation.

## 12b. Background placement, Wayland, memory, and phone alerts

### Background placement (nested display)

`execution.placement: "background"` (or `AGENTHOST_EXECUTION_PLACEMENT`) starts a
nested Xephyr display (`:90` upward) when the server starts. Screenshots, input,
window tools, app launch, and a headed `browser.open` all target it, so the
person keeps their own cursor, keyboard, and screen; the nested desktop appears
as one window they can watch or minimize. If it cannot start, the server fails
with `background_display_unavailable` instead of acting on the real screen.

Limits, all by design or environment:

- There is usually no window manager inside it: windows open at the corner and
  "active window" means X input focus (`getwindowfocus`, `windowfocus`,
  `xwininfo -root -children`).
- `ui.*` fails with `unsupported_in_background`: AT-SPI is one session-wide bus
  and would reach apps on the real desktop.
- `shell.run` still runs with the server's environment, so a command that
  opens a window appears on the real display.
- Yield-to-user and the target ring are off; overlay cards stay on the real
  screen so stop and approval remain reachable.
- The nested display has its own clipboard.

### Wayland

On a Wayland session with XWayland, windows, input, screenshots, and cards work
for X11 (XWayland) apps. Native Wayland windows are not reachable directly: there
is no XTEST or global window list. See `docs/13_PLATFORMS.md`.

For native Wayland apps, `execution.placement: "background"` is the supported
path, because Xephyr runs under XWayland and gives AgentHost a real X
display. Apps must be started by AgentHost to live inside it; it cannot control
native Wayland windows outside it. This was verified end to end against a
headless GNOME Wayland compositor using a standalone `Xwayland`; mutter's own
on-demand XWayland did not serve clients in headless mode, so a normal logged-in
Wayland session has not been exercised. `agenthost doctor` prints this guidance
on Wayland.

### Memory

`memory.save`, `memory.search`, and `memory.delete` keep short lessons about how
to work on this computer, at most 200 entries of 300 characters in
`~/.agenthost/memory/lessons.json`. Secrets are refused, and search results are
marked `untrustedContent` because a lesson can originate from a hostile page.
Operators can inspect and erase everything: `agenthost memory
list|delete <id>|clear --yes`.

### Phone notifications and approvals

`notifications.pushUrl` (https, opt-in) receives one fixed POST, at most every 30
seconds, saying AgentHost is waiting at the computer. It carries no preview,
app name, task text, or token, and it cannot approve anything.

Phone approvals are a separate opt-in, off until paired:

```bash
agenthost phone pair --publish <url> --poll <url> [--max-risk medium|high]
agenthost phone status
agenthost phone unpair
```

The channel is any ntfy-style pair of URLs, for example private `ntfy.sh` topics.
AgentHost makes outbound requests only and polls only while a request is pending.
Each pending confirmation from this server is published with its redacted preview
and a short reference. Reply `approve <ref> <code>` or `deny <ref> <code>`. That
makes the same decision as `agenthost confirm|deny`: the agent may retry that one
exact action, once. Requests above `--max-risk` (default `medium`) stay
computer-only, and the card and CLI keep working.

Trust model:

- The machine stores only salted hashes of 20 one-time codes, so nothing an agent
  can read on this computer can answer a request. Codes are shown once at
  pairing. A code works once. Five wrong codes disable the channel.
- Pairing needs a real terminal and a real-pointer press on a card, and it is
  refused when `overlay.allowSyntheticControl` is on.

Known risks, accepted by choosing to pair:

- **Previews leave the machine.** Redacted summaries go to the channel's operator
  and anyone who knows the topic name. Use a self-hosted server or long random
  topic names.
- **A spoofed request.** The channel URLs are readable on this machine, so an
  agent could post a fake request to the channel showing a harmless preview with
  the reference of a real one, and trick you into approving it. Approve only what
  you just asked for; when in doubt, deny and check at the computer.
- **Weaker than the card.** Approval no longer proves someone is at the machine.
- **Codes on screen.** An agent with screen access could read codes left in the
  terminal. Clear it after saving them, and `phone unpair` if in doubt.

### Dropped

A pixel-based "did the click do anything" check: AgentHost's own cards and rings
would always register as change. The old geometry-based hint could never change,
so it was removed.

## 13. Data, privacy, and logging

### Runtime data

```text
~/.agenthost/
  logs/
  screenshots/
  outputs/
  tasks/
  run/
    confirmations/
    stop.requested
    takeover.active
    pause.requested
    activity.json
    overlay.hide
```

Installed public config lives under `~/.config/agenthost/`. Installation files
live under `~/.local/share/agenthost/` with the launcher at
`~/.local/bin/agenthost`.

### Audit logging

Every governed tool call writes one JSONL entry with:

- Timestamp, session, tool, risk.
- Execution strategy.
- Server version and entry path.
- Preview/confirmation status.
- Redacted input summary.
- Approval status, success/failure, duration, error code.
- Numeric `timings` for action-card wait, safety gate, preview, handler, audit
  preparation, and total.
- Bounded output summary.

Logs never include:

- Passwords, API keys, cookies, private keys.
- Confirmation-token values.
- Full sensitive files.
- Screenshots.
- Raw OCR or page text.
- Hidden environment values.

A failed audit write does not repeat a completed action.

### Local-only boundary

- MCP over stdio.
- No public listener.
- No telemetry upload.
- No cloud OCR.
- No access to the person's own browser profile, cookies, or storage. `browser.*` drives a separate AgentHost profile on a loopback-only debugger port.
- No credential extraction.
- No CAPTCHA, MFA, login, payment, or security bypass.
- No generated code execution in this tree.

## 14. Packaging and release

AgentHost ships as a Linux x86_64 archive with a rootless CLI:

```text
~/.local/share/agenthost/
~/.local/bin/agenthost
~/.config/agenthost/config.json
~/.agenthost/
```

No sudo, system service, package installation, or hidden browser installation.

Release workflow:

```bash
npm run build
npm run release:build
npm run release:scan
npm run release:verify
npm run release:install -- release/agenthost-v0.1.0-linux-x64.tar.gz
```

The archive contains compiled runtime, production dependencies, renderer
assets, version manifest, documentation, legal files, and per-file hashes.
Release scans reject credential-like material, current-user absolute paths,
runtime state, logs, screenshots, caches, temporary files, and unsafe release
contents.

No npm publication is promised; the supported public artifact is the Linux
archive and CLI. The project is Apache-2.0 licensed. Host programs such as
GTK3, Tesseract, eSpeak NG, and Bubblewrap remain separately licensed and are
never bundled.

## 15. Reliability and performance behavior

Current v2 safeguards include:

- Capability probing cached for 30 seconds.
- Cache bypass when a custom accessibility probe is supplied.
- Window list caching.
- OCR result caching per image.
- `computer.wait_for` instead of fixed sleeps, with state snapshots/fingerprints.
- `computer.run_steps` for bounded multi-step plans without a model round trip
  between each step; every nested call still re-enters the governed runner.
- Plan-scoped confirmation for low/medium effects; high-risk steps still need
  their own token.
- State-changing execution is serialized per MCP session; read-only calls may
  run concurrently and stop/takeover is rechecked after queueing.
- Optional `AGENTHOST_TRACE=1` writes redacted timestamped phase traces under
  `~/.agenthost/logs/traces/<session>.jsonl`.
- Active-window verification before GUI input.
- Focus verification and fallback.
- Screenshot directory creation, stale-file removal, and zero-byte rejection.
- Explicit `type_failed`, `hotkey_failed`, `click_failed`, `pointer_failed`,
  `screenshot_failed`, and `focus_failed` errors.
- Overlay prewarming with non-blocking execution.
- Redacted duplicate-call nudges at the 3rd and 6th repeated call.

## 16. Host requirements and limits

### Supported boundary

- Linux x86_64 first.
- Node.js 20+.
- X11 is the verified visible-overlay path.
- Python 3 and GTK3/PyGObject are needed for the visible overlay.
- Tesseract is required for OCR/vision.
- `xdotool` is needed for desktop input and window control.
- `xclip` or `xsel` is required for non-ASCII typing.
- `xprop` is required only for `overlay.layout: "dock"` work-area reservation.
- Wayland reports limited or unavailable global-overlay features.

### What is not live in this tree

Do not treat these as available features:

- The extension-based Browser Bridge.
- Accessibility MCP tools.
- Speech tools.
- Forge runtime tools.
- Workflow, scheduler, replay, receipt, or checkpoint tools.
- Control Room.
- Runtime-activity MCP service.
- `task.execute_plan`.
- Generated MCP tools.
- Browser cookie, storage, or debugger automation.
- Background daemon or autonomous scheduling.
- Recursive directory deletion.
- MCP-side resume/clear of stop, takeover, or pause.
- App-specific adapters (the Blender and SSH adapters were removed).

## 17. Typical agent operating loop

```text
1. Read agenthost://capabilities.md
2. Create a task with observable completion criteria
3. Follow the fidelity ladder: shell/file or an app adapter first, then
   accessibility/GUI only when needed
4. For GUI input, pass `target: {windowId|appName|title|pid}` when possible;
   click by visible `label` or set fields with `desktop.set_field`, or click a point in a
   returned screenshot by `screenshotId`; read the window with `screen.read` before
   taking a picture;
   use the returned bounded `state` snapshot instead of observe-then-act
5. Use `computer.run_steps` for known bounded sequences
6. Act with the safest applicable tool and verify the returned state/result
7. Pass `task: {phase?, currentAction?}` for routine bookkeeping; reserve
   `task.update`/`task.add_event` for explicit, richer records
8. Complete the task only after every criterion is verified
```

For consequential work:

```text
dryRun:true -> inspect exact preview -> operator confirm -> retry with token
```

For long or uncertain work:

```text
task.create -> task.update -> task.add_event -> task.update_status
```

## 18. Validation snapshot

At the time of writing, the tree passes:

- `npm run build`
- `npm run lint`
- `npm test` — 94 files, 581 tests
- `npm run smoke:mcp` — 70 tools, 3 resources
- `npm run test:windows` — 10 files, 83 tests: the unit tests that do not assume Linux (run in CI on windows-latest, which is informational for now)
- `node scripts/windows-smoke.mjs` — the built server over stdio: 12 checks here on Linux; `scripts\windows-check.ps1` runs it on Windows (not yet run there)
- `npm run check:live` — 79 checks on a nested display and headless Chrome (CLI, desktop, browser, session end, file dialogs, plans, screenshot ids); opens a small window on your screen for about a minute
- `npm run benchmark:form` — one form task three ways; the gate for the pixel path is 50% fewer calls, 40% fewer bytes, no unverified successes. Latest run: pixel-after -53% calls and -48% bytes against pixel-before; the browser route -68% calls and -98% bytes
- `npm run benchmark:agent` — isolated, non-destructive runner overhead benchmark
- `npm run benchmark:tasks` — 20 isolated scenarios, 22 governed calls in the latest run; desktop-input/OCR scenarios use mocked backends
- `git diff --check`

Real X11 screenshot capture was also verified with `scrot` at 386,291 bytes.
Counts are transient; use the live capability resources for authoritative
inventory.
