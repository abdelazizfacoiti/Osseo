# Phase 3 design: the host service and one rail

Status: design only. No code changes in this document's commit. Source: `docs/notes/product-plan.md`, section 2 (One server per session), section UI (rail, global Stop), the Phase 3 row and the decisions list.

## 1. Problem

What runs today, per MCP client session:

- One `node packages/mcp-server/dist/index.js` process. `startStdioServer` (`server.ts:664`) builds a full `createAgentHostMcpServer`: its own `AgentHostMcpContext`, `OverlayManager`, `ActionOverlay`, `ActionTimeline`, `TaskActivityOverlay`, `ApprovalOverlay`, `HandoffOverlay`, browser session and (when configured) Xephyr (`backgroundDisplay`).
- One `gtk3-renderer.py --protocol` child per server (`linux-renderer.ts`, pid file per session). The renderer draws the dock, pills, ring and cards.
- With N sessions: N servers, N renderers, N docks. The measured case this week was five renderers alive at once. Each dock reserves 18% of the screen through an `xprop` strut, so docks stack.

Four symptoms with one cause (nobody owns the screen):

1. Stacked docks and cards. Each session paints its own, so two sessions show two timelines that cover each other.
2. Orphan renderers. A renderer holds pipes to its server, so a killed server leaves a card on screen. `sweepOrphanedOverlayRenderers` (`linux-renderer.ts:41`) is a repair step run at start (`server.ts:378`) and at close (`server.ts:648`). It skips renderers whose parent is alive, so it cannot fix a hung live server.
3. Two agents on one mouse. `withStateChangingLane` (`execution-gate.ts`) keys its queue on a `WeakMap<AgentHostMcpContext, ...>`. One context per session means one queue per session. Two sessions never queue behind each other.
4. Stop state in files. `run/stop.requested`, `pause.requested` and `takeover.active` (`run-state.ts:21-25`) are global files, but each session polls them on its own clock and shows its own card. Stop in one card is visible in another only after that card's next poll. No hotkey exists, because no long-lived process could hold one.

Also: `agenthost start` (`agenthost-cli/src/index.ts:140`) refuses when the lock pid is alive (`agenthost_already_running`). It is a foreground wrapper, not a service, and MCP clients do not use it.

## 2. Architecture

One host process per user. One thin shim per MCP client.

```text
MCP client A --stdio--> shim A --\
MCP client B --stdio--> shim B ---+--unix socket--> HOST --> tool-runner --> OS adapters
MCP client C --stdio--> shim C --/                   |--> card renderer (one)
                                                      |--> rail + tray + Stop hotkey
                                                      |--> input queue, stop/pause flags,
                                                           approval queue, session history
```

Socket: Linux `$XDG_RUNTIME_DIR/agenthost/host.sock`, fallback `~/.agenthost/run/host.sock`. Directory mode 0700, socket mode 0600, peer uid checked with `SO_PEERCRED` where available (Node cannot read it directly; the directory mode is the real guard). Windows: named pipe `\\.\pipe\agenthost-<user-sid>` with a DACL for the current user. The Windows pipe is a later phase (see section 9).

Where each owned thing lives today and where it moves:

| Thing | Today | In the host |
|---|---|---|
| Input queue (one driver at a time) | `execution-gate.ts`, per context (per session) | One queue in the host. Same function, one shared `HostContext` key. Adds a visible owner (session label) |
| Card renderer | One `LinuxOverlayRenderer` per server (`server.ts` via `createOverlayRenderer`) | One renderer, created by the host |
| Stop, pause, takeover | Files under `~/.agenthost/run/`, read by every session | Host holds the truth in memory and still writes the same files (CLI and old servers keep working) |
| Approval queue | `confirmations.ts` files plus per-session `ApprovalOverlay` and chat elicitation in `server.ts:600-625` | Host owns one queue and one approval card. Chat elicitation stays in the shim's client session (only the client can show it) |
| Session history | `ActionTimeline` per server, audit JSONL per session | Host `ActionTimeline` merges all sessions, each entry tagged with a session label. Audit files stay per session |
| Task activity card | `TaskActivityOverlay` per server | One in the host, keyed by task id |
| Browser session | `context.linux.browser` per server | Stays per session in the host (own tab group), closed when the session detaches |
| Xephyr | `backgroundDisplay` per server | One per host (Phase 4 will make it the default) |
| Tool execution | `tool-runner.ts` in each server | `tool-runner.ts` in the host, unchanged |

Per-session state that must stay per session inside the host: `sessionId`, view registry (`view-registry.ts`, numbers from `see`), screenshot registry, rate limits, elicitation callback. The host keeps a `Session` object per connected shim and builds an `AgentHostMcpContext` for it that shares the host-wide pieces above.

## 3. Lifecycle

Start on demand:
1. The shim connects to the socket. On `ENOENT` or `ECONNREFUSED` it takes a start lock (`O_EXCL` file `host.start.lock` with pid and time), spawns `node host.js` detached with stdio ignored, then retries the connect with backoff for up to 8 s. A second shim that loses the lock just retries the connect.
2. If it still cannot connect, the shim reports one MCP error naming `agenthost doctor`. It does not fall back silently, except when `AGENTHOST_HOST=0` is set (section 11).

Stale socket detection: connect fails with `ECONNREFUSED` while the file exists, or the pid in `host.pid` is dead (`kill(pid, 0)`). The shim removes the socket and pid file under the start lock and starts a fresh host. The host itself, on start, takes `host.pid` with `O_EXCL`; if it exists and the pid is alive and answers a `hello`, the new host exits with code 0 (someone else won).

Idle exit: the host exits when there are zero attached shims, no running task, no pending approval and no stop/pause flag raised, for 10 minutes (config `host.idleExitMinutes`, default 10). Exit order: close cards, stop Xephyr, remove socket and pid file. The 6 s exit deadline from `startStdioServer` moves to the host.

Crash restart: the next shim call finds a dead socket and restarts the host (above). A shim that is already attached sees the socket close. It reconnects once, with the same `sessionId`, and replays nothing: in-flight `tools/call` requests fail with `host_restarted` and the model retries. After 3 failed restarts in 60 s the shim stops trying and returns `host_unavailable`.

Orphans: the host is the only parent of the renderer, so the sweep runs once at host start and once at host exit. A client killed leaves its shim dead; the host sees the socket close, ends that session (closes its browser tab group, drops its view registry, cancels its queued calls) and keeps everything else.

Upgrade handover: the handshake carries `build` (version plus a hash of `dist`). When a shim has a newer build than the running host:
- If the host is idle (no running task or approval), the shim sends `shutdown {reason:"upgrade"}`, waits for the socket to go away, and starts the new host.
- If busy, the shim attaches to the old host anyway when `protocol` matches, and logs one warning. The new build takes over when the host next goes idle. If `protocol` differs the shim refuses with: `AgentHost host is running an older protocol (N). Finish or stop the running task, or run agenthost host restart.`
- `agenthost host restart` stops it after confirming no task is running; `--force` stops it regardless.

Running task on host restart (crash or forced restart): tasks are already persisted in `~/.agenthost/tasks/`. On start the host loads recent tasks (the 24 h rule `TaskActivityOverlay` uses today) and marks any task that was `active` as `paused` with reason `host_restarted`. It does not resume them. The rail shows "Task paused: host restarted" with Resume. Pending confirmation tokens stay valid (they are files with a 15 minute life). An action that was mid-flight is reported as failed with `host_restarted`, never retried.

## 4. Protocol

Transport: newline-delimited JSON over the socket (the same framing the card renderer uses, so `serializeRendererMessage` style size limits apply: 1 MiB per message, 64 in flight per connection). Base64 images ride inside tool results, as they do over MCP now, so the cap for result frames is 16 MiB.

Handshake (first message, from the shim):

```json
{"t":"hello","protocol":1,"build":"0.x.y+abc123","client":{"name":"codex","version":"..."},"clientCapabilities":{"elicitation":true},"sessionId":"..."}
```

Reply: `{"t":"hello_ok","protocol":1,"build":"...","hostPid":123,"session":"s_7"}` or `{"t":"error","code":"protocol_mismatch","message":"Host speaks protocol 2, this shim speaks 1. Update the AgentHost MCP entry or run agenthost host restart."}` followed by close. `protocol` is a single integer, bumped on any incompatible change. Additive fields do not bump it; unknown fields are ignored.

Message types (all carry `id` for request/response pairs):

| Type | Direction | Purpose |
|---|---|---|
| `hello`, `hello_ok` | shim to host, back | Handshake, session creation |
| `tools_list` | shim to host | Returns the profile-filtered list. Host owns the profile and `tool-profile.ts` |
| `tools_call` | shim to host | `{name, arguments, meta}`; host runs `tool-runner.ts`, replies `tools_result` with the same `McpToolResult` that `toMcpToolResult` builds today |
| `resources_list`, `resources_read` | shim to host | The `agenthost://` resources (`ListResourcesRequestSchema`, `ReadResourceRequestSchema` in `server.ts`) |
| `elicit` | host to shim | Ask the client to show a chat approval; shim calls `server.elicitInput` and replies `elicit_result`. Replaces the direct call at `server.ts:608` |
| `cancel` | shim to host | Client cancelled a request (MCP `notifications/cancelled`) |
| `event` | host to shim | Optional: `queue_position`, `driver_changed`. Shim may log it; never forwarded to the model |
| `ping`, `pong` | both | Liveness every 15 s; 3 missed pings close the connection |
| `host_status`, `host_shutdown` | CLI to host | Used by `agenthost host status|restart|stop`, `doctor`, `overlay status` |
| `stop`, `pause`, `resume` | CLI, rail, hotkey to host | Operator controls (see section 6) |

The shim is dumb: MCP `initialize` is answered by the shim from the host's `hello_ok` data; it maps `tools/list`, `tools/call`, `resources/*` one to one. It holds no tool code and imports no `os-linux`, `os-windows` or `app-overlay`. This keeps its start time low (target under 150 ms to first byte) and means every MCP client costs a small Node process.

Existing functions that become RPC calls (the handler body stays; the transport changes):
- `createAgentHostMcpServer` request handlers for `ListTools`, `CallTool`, `ListResources`, `ReadResource` move behind `tools_list`, `tools_call`, `resources_*`. The `CallTool` handler body at `server.ts:550` becomes `Session.callTool`.
- `askInChatDetailed` (`chat-approval.ts`) gets `elicit` injected instead of `server.elicitInput`.
- `requestStop`, `clearStop`, `beginTakeover`, `requestPause`, `clearPause` (`run-state.ts`) stay as-is; the host calls them and CLI commands call them through `stop|pause|resume` when the host is up, and write the files directly when it is not.
- `withStateChangingLane(context, ...)` is called with the host-wide context, so serialisation is global. Stop/takeover recheck after queueing stays.

Queue behaviour: the lane queues state-changing calls from all sessions in arrival order. A queued call waits at most `host.queueTimeoutMs` (default 30 s), then returns `busy` naming the current driver label and how long it has held the input. Read-only calls run concurrently, as now. A driver "lease" is per call, not per session, so two agents interleave at call boundaries; this is simple and avoids deadlock from a session that goes quiet. Whether to add per-task leases is a user decision (section 12).

Tool execution path: unchanged. `tools_call` goes `Session.callTool -> tool-runner.ts -> handler`. Audit logging, stop gate, previews and tokens are the same code, so the P0 rules hold without new proof.

## 5. The one rail

The rail replaces the dock as the default surface (`overlay.layout: "rail"`; `dock` stays selectable until section 11 removes it).

Collapsed, about 48 px wide, on the configured edge (default right), full work-area height, strut reserved so windows do not go under it:
- Top: status dot. Grey idle, green running, amber waiting for approval, red error, blue paused or taken over.
- Middle: current action in about three words ("Click Save", "Type in Name"), vertical or short. Allowlisted labels only, as `ActionTimeline` does today (no typed text).
- Driver tag: a one-letter or short badge for the session that holds the input ("codex"), and a queue count when others wait.
- Bottom: Stop (always visible, large target), then Pause/Resume.

Expands (to about 320 px, over the work area, not moving windows) on:
- Hover or keyboard focus on the rail.
- A pending approval (auto, raises, notification as today), showing the approval card with Approve, Deny, Always allow here.
- An error state or a stopped task (shows reason, Resume, Dismiss).
It collapses 2 s after the pointer leaves and nothing is pending.

Expanded content: the merged timeline (newest first, all sessions, session tag per row), the current task checklist, the queue ("codex is waiting 12 s").

Stop control: Stop is global. It calls the host `stop`, which (a) sets the stop flag for every session, (b) cancels all queued calls with `emergency_stop_requested`, (c) lets an in-flight tool call finish (unchanged rule: Stop never kills it), (d) leaves each task `stopped` with Resume. It is not per session. A per-row "stop this task only" action exists in the expanded view, and it uses `task.cancel`.

Safety rules carried over unchanged: pointer-only activation for Pause/Resume/Stop/Cancel, the `run/input-active` 1 s guard, XTEST device rejection, physical-device proof for Approve/Resume/Continue (`overlay_input.py`). The host process runs the input guard check against its own injected input, which is the same process that injects, so the guard becomes simpler.

Kept from existing code: `ActionTimeline` (rows, merging, pinned alerts), `dock_layout` geometry and strut handling in `overlay_geometry.py` (the rail is a narrow dock), `ApprovalOverlay`, `TaskProgressOverlay`, `TaskActivityOverlay`, the `OverlayManager` event routing, screenshot suppression and `workWindowCaptureClean`. A 48 px strut counts as "dock reserving space", so window-only captures stay clean.

Removed once the rail ships: dock width percent (`overlay.dockWidthPercent`), the floating pill, edge frame and target ring defaults (they are legacy keys per the plan; Phase 5 may bring floating marks back).

## 6. Global Stop

Options:

| Option | Linux X11 | Linux Wayland | Windows |
|---|---|---|---|
| Hotkey grab inside the host | `XGrabKey` on the root window (needs a small helper: GTK `Keybinder` is not installed by default; python3-gi cannot grab without it; `xbindkeys` is an extra package). Works only on X11 and Xephyr-free root | Not possible for an ordinary client. Needs the GlobalShortcuts portal (`org.freedesktop.portal.GlobalShortcuts`, GNOME 48+ and KDE) and one consent prompt | `RegisterHotKey` from a message-only window thread. Needs a small native or PowerShell/C# helper; easy |
| Desktop-environment custom shortcut that runs `agenthost agent stop` | GNOME: `gsettings` custom keybinding written once with consent; KDE: `kglobalaccel` file | Same (this is the DE's shortcut, so it works on Wayland) | Not applicable; use `RegisterHotKey` |
| Tray icon with a Stop item | StatusNotifierItem over D-Bus (GNOME needs the AppIndicator extension, which is not default) | Same | `Shell_NotifyIcon`; reliable |

Recommendation: ship the DE custom shortcut as the primary Linux Stop (default Ctrl+Alt+Esc, chosen at install with a preview and `--apply`, via `agenthost setup hotkey`), because it works on X11 and Wayland, needs no grab code, and survives a host crash since it runs the CLI, which writes `run/stop.requested` directly. The CLI command already exists (`agenthost agent stop`). Add the portal path for GlobalShortcuts as an upgrade when Phase 10 lands. On Windows use `RegisterHotKey` in the host's helper. The tray icon is secondary: a courtesy, since GNOME hides it by default. The rail Stop button remains the visible control.

Why: Stop must work when the host is hung. A shortcut that runs the CLI and writes the flag file does not depend on the host being alive; a grab inside the host does.

## 7. UI technology

The rail, approval card, task card and (Phase 4) viewer all need a UI toolkit. Today it is GTK3 through `gtk3-renderer.py` (1,999 lines of Python, started by `linux-renderer.ts`, with its own JSON-lines protocol). Windows W3 (overlay and approvals) is not started.

Option A: keep GTK on Linux, build WPF on Windows.
- Pros: no rewrite. Linux renderer works and has tests (`linux-renderer.test.ts`, `check:live`). WPF is native, small, and the PowerShell helper already exists.
- Cons: two UI codebases for the same rail, approval card and viewer, forever. Every design change is made twice. The strut, input-device proof and click-through logic is Linux specific and has to be re-found on Windows. Python and python3-gi stay a Linux dependency.

Option B: one cross-platform shell. Two real candidates:
- Tauri (Rust core, system webview: WebKitGTK on Linux, WebView2 on Windows). Small binary (about 10 MB). Cost: a Rust toolchain in the build, WebKitGTK 4.1 as a Linux package, and transparent click-through, strut reservation and always-on-top need extra native code on X11 (Tauri exposes some; strut and `_NET_WM_WINDOW_TYPE_DOCK` need `gdk` calls or a custom plugin). Wayland layer-shell is not supported by Tauri today. The viewer window (Phase 4) is easy. The physical-device input proof for Approve has no web equivalent: it needs a Rust native module reading evdev or a helper that stays Python. Python renderer: replaced; the Windows helper keeps doing input and UIA.
- Electron (Chromium and Node). Cost: about 100 MB per install and 150 MB RAM idle, and a second Node runtime beside the host unless the host runs inside Electron. Click-through (`setIgnoreMouseEvents`), always-on-top and transparent windows work on both platforms; strut and dock type on X11 need a native addon or `xprop` as today. Same evdev gap for physical proof. Python renderer: replaced. Windows helper stays for input and UIA. Update size and the "installs a browser" feel hurt a CLI-first product.

Either B option needs: a rewrite of about 2,000 lines of GTK plus about 350 lines of `linux-renderer.ts`, a new test harness (the nested-display check:live would drive a webview), and a new packaging step in `release:build` and `release:build:windows`. The physical-press and XTEST checks must be re-proved, and that proof is the P0 safety property.

Recommendation: Option A for Phase 3 and Phase 4, with the overlay protocol (`OverlayManager`, `linux-renderer-protocol.ts`) kept as the one stable interface so a later renderer can replace GTK without touching the host. Reasons: Phase 3 is already the largest change (host, shim, queue, rail); changing the toolkit at the same time raises risk, and the safety-critical input guards are built and tested on GTK. W3 on Windows then implements the same `OverlayRenderer` interface in WPF, driven by the same JSON-lines protocol, so only the draw code is duplicated, not the logic. Revisit when Wayland work (Phase 10) forces a new Linux renderer anyway: layer-shell needs GTK4 or a different toolkit then, which is the natural point to choose a shell. This is a decision for the user (section 12, item 1), and the plan says the user leans to one shell; this document does not choose for them.

## 8. Code changes, in build order

Step 1: protocol and host core (no behaviour change yet)
- New `packages/core/src/host-protocol.ts`: message types, `HOST_PROTOCOL = 1`, frame limits, validators. No Node-only imports.
- New `packages/mcp-server/src/host/host.ts`: socket server, session table, `Session.callTool`, idle timer, pid and start locks.
- New `packages/mcp-server/src/host/session.ts`: per-session context built from host-shared parts.
- Change `packages/mcp-server/src/server.ts`: split `createAgentHostMcpServer` into `createHostRuntime` (shared: overlay, renderer, timeline, task card, approvals, flags, gate) and `createSessionHandlers` (per session: handlers, view registry, elicit callback). The old function becomes the two composed in one process, which is the fallback in section 11.
- Change `packages/mcp-server/src/context.ts`: add `host?: HostShared` and a `sessionLabel`.
- Change `packages/mcp-server/src/execution-gate.ts`: key the lane on the host-shared object when present (`context.host ?? context`), and record the current driver label for the rail and for `busy` errors.

Step 2: the shim
- New `packages/mcp-server/src/shim.ts`: stdio MCP server that forwards to the socket, with host start-on-demand, reconnect once, stale socket handling, `elicit` handler.
- Change `packages/mcp-server/src/index.ts`: choose the shim by default, `startStdioServer` (in-process) when `AGENTHOST_HOST=0`.
- New `packages/mcp-server/src/host/main.ts` (bin entry for the host) and `packages/mcp-server/src/host/paths.ts` (socket, pid and lock paths per OS).
- Change `scripts/measure-tools.mjs`, `scripts/smoke-mcp*.mjs`, `scripts/check-live.mjs`: set the mode explicitly; add host cases.

Step 3: shared flags and CLI
- Change `packages/core/src/run-state.ts`: add `onChange` notification hook for the host (the files stay the source of truth for old readers). No new flag names.
- Change `packages/agenthost-cli/src/index.ts`: add `agenthost host status|start|stop|restart`; make `start` start the host instead of a foreground server (keep the old behaviour behind `--foreground`); `stop`, `pause`, `resume` and `agent *` talk to the host when it is up and write files when it is not; `doctor` reports host state, socket, attached sessions, renderer count (must be 1) and protocol; `overlay status` lists the host's renderer.
- Change `packages/app-overlay/src/linux-renderer.ts`: `sweepOrphanedOverlayRenderers` called only by the host (start and exit) and `agenthost overlay hide --orphans`.

Step 4: the rail
- Change `packages/mcp-server/src/action-timeline.ts`: session tag on rows, merged across sessions, driver and queue summary.
- Change `packages/app-overlay/runtime/gtk3-renderer.py` and `overlay_geometry.py`: rail layout (48 px strut, expand on hover and on approval or error, global Stop). Add `rail_layout` next to `dock_layout`.
- Change `packages/core/src/config` (overlay schema): `overlay.layout` accepts `rail` (new default); `host.idleExitMinutes`, `host.queueTimeoutMs`, `host.enabled`.
- Change `packages/mcp-server/src/task-overlay.ts`, `approval-overlay.ts`: constructed once by the host.

Step 5: hotkey and tray
- New `packages/agenthost-cli/src/hotkey.ts`: `agenthost setup hotkey [--apply]` for GNOME (`gsettings`) and KDE. Preview by default, like `policy add`.
- New Windows files later: `packages/os-windows/src/hotkey.ps1` helper (`RegisterHotKey`) and tray via the existing PowerShell helper.
- Optional: `packages/app-overlay/runtime/tray.py` (StatusNotifierItem) after the rest works.

Step 6: Windows pipe (later phase)
- Change `host/paths.ts` to return a pipe name on `win32`; `net.createServer().listen(pipeName)` works in Node unchanged. Add a DACL step in the helper. Extend `scripts\windows-check.ps1`.

Step 7: removal (after the fallback goes, section 11)
- Delete the in-process path in `server.ts` (`startStdioServer` body and the per-session overlay construction), the per-session `.pid` file logic in `linux-renderer.ts`, `overlay.dockWidthPercent` and pill, frame and ring config, and the foreground-lock logic in `agenthost start`.

Tests to add, same order: `host-protocol.test.ts` (core), `host.test.ts` (socket, handshake, mismatch, idle exit, stale socket), `shim.test.ts` (forwarding, reconnect, `host_restarted`), `execution-gate.test.ts` (cross-session queue and `busy`), `rail-layout.test.ts` (geometry), `host-e2e.test.ts` (built host and three shims over stdio, headless).

## 9. Risks and what can be tested here

Risks:
1. Everything goes through one process. A bug in the host breaks all sessions. Mitigation: keep the in-process fallback, ping/pong, restart on crash, and a `doctor` check.
2. Security of the socket. Any local process of the same user can send `tools_call`. That is no worse than today (any process can run `agenthost confirm`), but it must not let a tool call approve itself. Approve, Resume and Stop-clear must still need the physical press, so they must never be accepted over the socket from a shim. Only the renderer connection and the CLI (with its existing checks) may resolve approvals. Add a test that a shim connection sending `confirm` is refused.
3. Elicitation needs the right client. The host must send `elicit` to the shim whose call raised the confirmation, and fall back to the card if the shim is gone.
4. Queue fairness and starvation: a long-running call blocks others; the `busy` timeout and the visible owner contain it. Per-call leases mean two agents can still interleave a multi-step form. Mention in docs.
5. Upgrade and mixed builds: old per-session servers running while a new host starts will both own a renderer for a while. The sweep skips live parents, so both can exist. The host must refuse to start the rail if it finds a live legacy renderer, and `doctor` says so.
6. The X11 claim in the plan (GNOME dropped X11) is unverified. If true, the strut, XGrabKey and `xprop` paths in this design are short-lived; the DE shortcut choice in section 6 was made partly for this reason.
7. Idle exit during a long human pause (approval pending for an hour). The idle rule counts a pending approval as busy.
8. Windows named pipe and `RegisterHotKey` are unproven until the user's run.

Testable here (Linux, headless and with Xephyr, no real screen touched):
- Protocol, handshake mismatch, framing limits, session table: unit tests.
- Start on demand, stale socket, idle exit, crash restart (kill -9 the host), upgrade handover with two fake builds: tests with temp `AGENTHOST_HOME`.
- Cross-session queue ordering and `busy`: unit and e2e.
- Three shims, one host, one renderer: Xephyr nested display, count processes with `pgrep`.
- Rail geometry: pure tests like `overlay-geometry.test.ts`. Rail look and hover: `check:live` on Xephyr.
- GNOME shortcut writing: preview only here (`--apply` changes the user's settings; test against a temp `GSETTINGS_BACKEND=memory`).

Not testable here: Windows pipe, `RegisterHotKey`, WPF rail, tray icons on GNOME with the extension, Wayland GlobalShortcuts. These wait for the user's runs (`scripts\windows-check.ps1`, `scripts\windows-desktop-check.ps1`).

## 10. Test plan

Commands for every step: `npm run build`, `npm run lint`, `npx vitest run`, `npm run smoke:mcp`, `node scripts/windows-smoke.mjs` (must still pass; it runs on any OS), `npm run test:windows`. After step 2 also `node scripts/measure-tools.mjs` (shim `tools/list` bytes must equal the in-process bytes) and `npm run benchmark:agent`.

End-to-end checks from the plan (Phase 3 verification), as `npm run check:host` (new script, nested display):
1. Start three client sessions (three shims over stdio). Assert `pgrep -f host/main.js` gives 1 process, `listOverlayRendererPids()` gives 1, and `agenthost overlay status` shows one rail.
2. Kill one client (`kill -9` the shim). Within 3 s assert the host dropped that session, its browser tab group is closed, no new orphan renderer or Xephyr exists, and the other two sessions still answer `tools_call`.
3. Kill the last two clients. After idle time (test sets `host.idleExitMinutes` to a few seconds) assert the host exited, the socket and pid file are gone, and no renderer is left.
4. Two sessions each send a state-changing call at once. Assert they run in arrival order, the second waits, the rail shows the driver and queue count, and a call past `queueTimeoutMs` returns `busy` with the driver label.
5. Stop from the CLI and from the rail button: all sessions see `emergency_stop_requested` on their next state-changing call, queued calls are cancelled, and the in-flight call completes.
6. `kill -9` the host during a running task. Next call from a shim restarts the host, the task is `paused` with `host_restarted`, Resume works, the in-flight call is reported failed and not repeated.
7. Protocol mismatch: start a shim built with `protocol+1`; assert the refusal message text and a clean close.
8. Stale socket: leave a socket file with a dead pid; assert the shim recovers.
9. `AGENTHOST_HOST=0`: the whole existing `check:live` (80 checks) and `see-e2e.test.ts` still pass unchanged.
10. Approval path: a `confirmation_required` result from session B raises the card once, chat elicitation goes to B's client only, and a shim cannot send `confirm`.

Add `check:host` to the 80-check live suite documentation in `AGENTS.md` when it lands.

## 11. Migration

- Default flips in two releases. Release N: host available behind `host.enabled: true` or `AGENTHOST_HOST=1`; the default stays the in-process server. Release N+1: host is the default; `AGENTHOST_HOST=0` (or `host.enabled: false`) restores the in-process server. `doctor` prints which mode a client entry runs in.
- The client entries written by `agenthost integrations <client> add` already point at the MCP entry; they do not change. The shim is the new default behaviour of the same entry, so no client re-registration is needed.
- During the overlap, both modes write the same flag files, audit logs, confirmation tokens and tasks, so CLI commands work with either.
- Old and new running together: the host refuses to take the rail while a legacy renderer from an old-mode server is alive (risk 5) and reports it.
- The fallback can be removed when: (a) `check:host` and `check:live` have passed on Linux for two releases with the host default; (b) the Windows pipe path has passed `scripts\windows-check.ps1` and `windows-desktop-check.ps1` on the user's machine; (c) no open bug names the fallback. Then run section 8 step 7. Keep `AGENTHOST_HOST=0` for one more release as a deprecation warning only.

## 12. Decisions for the user

1. UI technology: keep GTK on Linux and build WPF on Windows (option A), or move to one shell (Tauri or Electron, option B). Recommendation: A for Phases 3 and 4, with the overlay protocol as the stable seam, and decide on a shell when the Wayland work forces a new Linux renderer. The plan says you lean toward B; this is your call and changes W3 scope.
2. Global Stop on Linux: DE custom shortcut running the CLI (recommended, works on X11 and Wayland, survives a hung host) versus a grab inside the host (X11 only). Default key Ctrl+Alt+Esc?
3. Queue policy: per-call lease with a 30 s `busy` timeout (recommended), or per-task lease that keeps one agent in control until its task ends (safer for forms, but one stuck session blocks the rest).
4. Host idle exit time: 10 minutes (recommended), or never exit (faster tools, a permanent process and rail).
5. Rail edge and default: right edge, 48 px collapsed (recommended, matches today's dock side), expand on hover; or left.
6. Tray icon: build it now (small value on GNOME without the extension) or postpone until Windows, where it matters. Recommendation: postpone on Linux, build on Windows with the hotkey.
7. Rollout: two-release default flip with `AGENTHOST_HOST=0` fallback (recommended), or flip the default immediately since the repo is private.
8. Windows host transport: named pipe in the same phase as the Windows overlay (recommended, after your first Windows run), or keep Windows in-process until W3.
9. Per-session scope for the browser profile: one shared dedicated Chrome profile for all sessions with a tab group each (recommended, fewer processes), or one profile per session.
10. Stop and in-flight calls: keep the rule that Stop never kills an in-flight call (recommended), or add a hard cancel for calls over 10 s.

## Implementation status

Core built behind `AGENTHOST_HOST=1`; with it unset nothing changes (the in-process server is still the default, so this is not yet the section 11 default).

Done:
- `packages/mcp-server/src/host/`: `socket.ts` (`<home>/run/host.sock` mode 0600 under a 0177 umask, `run/` mode 0700, `host.pid` mode 0600, stale socket removal, `agenthost_host_running`), `lease.ts` (one lease, FIFO, 30 s wait, `host_busy`, freed in a `finally` and on disconnect), `protocol.ts` (newline JSON, `hello`/`welcome`/`refused`, 4 MB limit, malformed lines answered without closing), `session-transport.ts` (MCP transport over a connection; leases `tools/call` of `state_changing` tools from the tool's `execution.executionClass`), `host.ts` (one `createAgentHostMcpServer` per connection, idle exit), `main.ts` (host entry), `shim.ts` (stdio shim).
- `agenthost host status|start|stop|restart` in `packages/agenthost-cli/src/host.ts`. `restart` stops through the socket (SIGTERM only when the pid's command line names `host/main.js`), waits for the socket to close, and starts again; it refuses and starts nothing if the old host is still answering. `hostDoctorLine(agentHome)` returns `not_running`, `running`, `stale_socket` or `lock_held` and never starts anything.
- Start lock: `run/host.lock` (not `host.start.lock` as in section 3), created `O_EXCL` with `<pid> <epoch ms>`; `host start` and the shim take it before spawning, re-check the socket under it, and remove it when the socket answers or the start fails. A lock older than 30 s whose pid is dead is stale and is taken over. A second starter does not spawn; it waits for the first host (the shim connects to it, `host start` reports `agenthost_host_running`).
- Reconnect-once: a shim whose first connect fails starts a host through the lock and connects again (it polls for up to 10 s). It never re-sends a call after a drop.
- Operator messages without a handshake: `{"status":true}`, `{"ping":true}` (answers `{pong, protocol, pid, uptimeMs}`) and `{"shutdown":true}`. `host status` reports `running` only when the ping answers.

Differences from this design (simplifications for the core):
- The wire is the MCP JSON-RPC itself, not the typed `tools_call` messages of section 4, and the handshake is `hello`/`welcome` (protocol 1), not `hello_ok`. The shim holds no tool code.
- Each connection still builds a full per-session server, so each session still has its own overlay and renderer. The renderer ownership move (one renderer in the host) is not done.
- One lease per state-changing call, held host-wide; the in-process lane per session still applies inside it.
- Idle exit: 10 minutes with no connections and no task whose status is `active` (read from the task files). Pending approvals and stop/pause flags are not consulted.
- No upgrade handover. If the host dies the shim answers open requests with a JSON-RPC error (`host_disconnected`), keeps answering new requests that way for 2 s, then exits 1. It never retries a call. If two hosts still start at once, the second exits with `agenthost_host_running`.
- `host_busy` is returned as a tool result with `isError: true`, not a JSON-RPC error.

Not done: rail, tray, Stop shortcut, wiring `hostDoctorLine` into `doctor` (owner of `index.ts`), shim reconnect after a mid-session drop (the shim exits instead), `AGENTHOST_HOST=0` fallback semantics, Windows pipe.
