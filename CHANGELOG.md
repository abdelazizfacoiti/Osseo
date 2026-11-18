# Changelog

## Unreleased

- `overlay.frame: "always"`: a quiet gray edge frame whenever the server runs, coloured by state (blue running, green done, amber waiting or paused, red error), back to gray between actions. The frame is now four thin strips per monitor instead of a full-monitor window, so it can stay up without covering the work area and without blinking. Window-only screenshots no longer clear the cards for it, and the strip pixels are cropped out of a window that touches a screen edge (the screenshot reports the shifted origin). A configured target ring only forces a clear while one may still be on screen. Measured on a real X11 session: 4 strips stay up through a window capture, and the captured terminal's bottom rows are its own colour. `frame: true` and `false` work as before (the frame now uses the same strips).
- Windows, no C# and no DLL: the desktop helper, the UI Automation worker, the overlay and the smoke scripts run as PowerShell. The Win32 bindings are emitted in memory (`NATIVE_PS` in `@agenthost/os-windows`), so nothing is compiled and no DLL is written to the temp folder; antivirus policies that block such DLLs no longer apply. Checked on Windows 11 (2026-11-17): desktop check 32 of 32, headless check 12 of 12, browser 6 of 6, numbered actions 7 of 7, dock 17 of 17, overlay 9 of 10 (the real click on Stop is still open).
- Fixed (Windows UI Automation): window roots came from `AutomationElement.FromHandle`, which returned WinForms children as generic panes, so buttons were reported as `panel` and a password box leaked its text as a name. Roots are now found with a desktop `FindFirst` by window handle.
- Fixed (Windows overlay): the state and pending-events lists were sent as `ArrayList`, which `JavaScriptSerializer` refuses, so the overlay reported no cards.
- Fixed (first Windows run): a UTF-8 byte-order mark in `config.json` stopped the server at start-up, because Windows PowerShell 5.1's `Set-Content -Encoding utf8` writes one and `JSON.parse` rejects it; the client only saw CONNECTION_CLOSED. Config, policy, workflows, tasks, memory and the CLI now strip one leading BOM.
- Fixed (first Windows run): `open` a URL failed on Windows with "xdg-open is not installed or not on PATH". Windows now opens the default browser through `rundll32 url.dll,FileProtocolHandler`, and a named browser (Chrome, Edge, Firefox, Brave) from its install folder in a new tab. A missing browser says so and suggests the default one.
- `agenthost setup guide`: the first-run path in one command. It makes the AgentHost folder, lists missing desktop packages with the command that installs them, runs the self-test, finds your agent clients (Claude Code, Codex, opencode, Cursor, Copilot CLI) on PATH and prints the exact register command for each that is not registered yet, then one safe first prompt to paste. It installs nothing and edits no client config. A failed self-test ends with exit 1 and names the step.
- Development failure log: every session's server appends each unexpected tool failure to `~/.agenthost/logs/failures.jsonl` (tool, error code, redacted message with home as `~`, audit input summary, first observation as a hint, build, platform, placement; never typed text). Confirmation prompts, pause, stop, takeover and user-active results are skipped as expected. Rotates at 5 MB. `agenthost failures summary|show|clear` reads it, most frequent reason first, so the next fix is the first line. A failing write never changes a tool result.
- Windows overlay (W3), opt-in with `AGENTHOST_WINDOWS_OVERLAY=1`: the action, task and approval cards are drawn with WPF in one Windows PowerShell process. Buttons act only on a real mouse press (a low-level mouse hook marks injected input), so the agent's own clicks cannot approve or stop. Checked on Windows 11 Pro (2026-11-16): `node scripts\windows-overlay-smoke.mjs` passes 10 of 10. A synthetic click on Stop is refused and a real click on Stop is accepted. The check now counts only the card it shows, so another AgentHost session's card with the same title does not fail it.
- Windows overlay dock (W3), with `overlay.layout` `dock` (the default): the overlay reserves a strip on `overlay.dockSide` with the shell, so maximized windows stop at its edge. The timeline and the bottom cards sit in the strip, and it goes when its last card does (after 2 seconds, so a screenshot does not resize windows; at once on emergency hide and close). The server passes the dock settings to the Windows process. Checked on Windows 11 (2026-11-16): `node scripts\windows-dock-smoke.mjs` passes 17 of 17, including the agent's own Chrome maximized against the strip. The rail layout is not drawn on Windows.
- Windows: the agent's own Chrome opens a visible window on its dedicated profile, reads a local form by DOM, fills and submits it, and reaches the confirmation page. Checked by `node scripts\windows-browser-check.mjs` (6 of 6, 2026-11-16). The earlier `connection_closed` on `browser.open` did not come back.
- Windows cards can be turned on in `config.json` with `"overlay": { "windows": true }`, as well as with `AGENTHOST_WINDOWS_OVERLAY=1`. `agenthost setup guide` reports whether they are on.
- Fixed (Windows): `agenthost selftest` and `setup guide` looked for Chrome only by Linux names on PATH, so they failed on Windows. They now use the browser tools' lookup, which includes the Chrome install folders. The client check now finds `claude.exe` on PATH, and a registration by the server's path (`node …\mcp-server\dist\index.js`) counts as registered.
- Windows release: the zip now contains the repo's packages (the first zip had none, so the installed CLI could not start). `npm run release:build -- --stage-only` builds the stage on Windows. `scripts\install.ps1` installs it into %LOCALAPPDATA%\AgentHost, and `agenthost update` and `update --rollback` switch the release junction (checked 2026-11-17).
- `agenthost doctor` on Windows leaves out the Linux-only checks and desktop packages, and its Windows guidance says what was checked.
- Windows checks rerun on Windows 11 Pro (2026-11-16): the desktop adapter `scripts\windows-desktop-check.ps1` passes 32 of 32, and the headless check `scripts\windows-check.ps1 -SkipInstall` passes 12 of 12 with the install dry run. The Windows release zip still cannot be built here: `release:build` needs the Linux stage.
- Windows cards match the Linux card more closely: timeline rows with state glyphs, bold labels and dim details; tinted status badges; key/value rows with a fixed key column; the Linux card gradient and edge.
- `agenthost integrations <client> add` on Windows writes `node <this CLI> start` when `agenthost` is not on PATH, so a checkout can register. The status check counts that form.
- `npm run release:build -- --stage-only` builds the platform-neutral release stage on Windows, so `npm run release:build:windows` can build the Windows zip there. The Linux tarball is still built on Linux only. The third-party notices check ignores CRLF line endings.
- The form benchmark has a numbered route that uses only the new tools (open, see, type, click, key, wait). It passes the same gate as the pixel routes: 9 calls against 19, and 4,620 bytes against 116,288. `npm run benchmark:form` now prints its gate for that route too.
- `npm run check:live` has a numbered-action section: see lists the page, type and click by number, a click on a control that does nothing reports no change, and a click on Send asks first. `LIVE_CHECK_ONLY=numbered` runs only that section, headless and with no window.
- Fixed: a screenshot could fail with `screenshot_surface_unknown` while a card was still being shown. That happened to the first screenshot after the host started, and to the second of two screenshots sent together through the host. A capture now waits for the shows already in flight, then clears the cards, so a late card is neither in the picture nor a failure. A test fails on the old code and passes on the new code.
- The plan's verification steps are recorded with their evidence in `docs/notes/phase-verification.md`: the tool-list size, the form and suite benchmarks, the three-client host run, the first-run self-test, and what is still blocked.
- `agenthost selftest --viewer` runs the form check on a background display (a nested display) that the viewer shows on the person's screen. It adds a Send step that must ask first (an approval waits, nothing is sent) and a check that the viewer draws frames. It needs DISPLAY, Xephyr and Chrome, and it stops the viewer and the server before it cleans up. Checked on a nested test screen: 9 of 9 steps pass, and the viewer's own frame shows the filled form. A bare Xephyr test screen has no compositing manager, so overlay cards report `overlay_not_visible` there. With a compositing window manager on the test screen (`gnome-shell --x11 --replace`), the approval card showed on screen (screenshot checked).
- Fixed: `agenthost viewer start` passed the caller's environment to the window and the frame loop, so with a non-default `AGENTHOST_HOME` the frames went to the default home. Both now get the agent home of the server.
- Wayland portal (opt-in, `AGENTHOST_WAYLAND_PORTAL=1`): on a Wayland session without the background display, `desktop.click`, `type_text`, `hotkey` and `screenshot` send input and capture the shared screen through the RemoteDesktop and ScreenCast portals. One consent covers both, and a refusal is kept for the session. The shared screen is the one target; window listing and focus are refused. `agenthost portal check [--start]` checks the portal on a Wayland login (without `--start` no dialog appears). Checked: the probe against the installed portal on this X11 login (no dialog), and the helper against a fake portal on a private bus. Not yet run on a real Wayland login. See `docs/notes/wayland-portal.md`.
- Teach mode: `guide.show` with `waitForClick` and several steps shows one card (`Step n of m`, Back, Next, and Done on the last step) beside the current box, with all boxes drawn. The call runs the walkthrough. A press on Next, Back or a box moves on, and Done or a click in the last box ends it, returning `finished: true`. The card's buttons are pointer-only, like Stop, and synthetic (XTEST) presses send nothing. If the card cannot be drawn, the guide falls back to tooltips. `teach_selftest.py` checks the card on a nested display (8 checks).
- `agenthost tray start|stop|status` shows an AgentHost icon in the system tray with the agent's state (running, paused, stopped, waiting for approval) and a menu: Stop, Pause, Resume and Open viewer. A menu item runs only on a real pointer press, never on injected input, and Resume also needs physical hardware, as the viewer does. The menu's refusal rules are tested. GNOME needs the AppIndicator extension; KDE shows the icon natively. Not yet checked on a real panel.
- The opt-in host service owns one overlay renderer for all its sessions. Each session gets a proxy whose overlay ids carry a session prefix, so events reach the right session, and a session's close removes only its own cards. Stop and renderer restart still act on every card. Sessions now share one dock; one merged timeline across sessions is not built.
- Shopify store admin pages (`admin.shopify.com`, and `*.myshopify.com/admin`) are no longer blocked as a security page. Reading and navigating are allowed. Sends, uploads, deletes and payments ask first, judged by the control's name (send, email, upload, delete, remove, pay, refund, charge, capture). Login, password and authentication pages stay blocked. A product Save runs without a prompt.
- Clicks pass the control's name to the safety check. `desktop.click` and `browser.click` take an optional `targetName`, used only for that check and never written to the audit line. A numbered `click` passes the name from `see`. A direct `browser.click` without a name uses the element's own name. A desktop click knows the page address only when the agent's own browser shows that page; a window titled Shopify gets the name rule as an ask-only hint.
- Replay: `replay.onTaskFinish` (opt-in, default off) writes a session replay in the background when an explicit task finishes. Task replays end with the task id's first 8 characters, so two tasks in one session do not overwrite each other.
- The browser extension's native host no longer deletes a running host's socket. A second host only relays its own Chrome connection. The extension reconnects with backoff (1 s to 60 s). `install-host.mjs --apply` writes an absolute-path launcher, so it no longer depends on node being on Chrome's PATH.
- The browser extension was run once in real headless Chrome 150: the manifest loads, the service worker starts, the native host answers a tabs request and refuses an unknown type, and the allow list and tab listing work. The content script was checked in a real page through a `chrome.runtime` shim (`page-check.mjs`: a text field typed and read back, password, one-time-code, card and token fields refused, a button clicked). Firefox 155 accepted the manifest through WebDriver BiDi (`firefox-check.mjs`). Not tested: the optional host permission grant (a person must allow it), `chrome.scripting.executeScript`, and the native host from Firefox. `chrome-check.mjs`, `page-check.mjs` and `firefox-check.mjs` repeat the checks; each uses a temp profile and no display.
- Added an opt-in `overlay.layout: "rail"`: a 48 px strip on the `overlay.dockSide` edge that shows a status dot, the current action in three words and Stop, and expands to the normal dock content on hover, during approval waits and on errors, collapsing 800 ms after the pointer leaves. The dock stays the default.
- The opt-in host service no longer races on start: `host start` and the MCP shim take a `run/host.lock` start lock, so two concurrent starts give one host. Added `agenthost host restart`, a `{"ping":true}` message that `host status` uses to confirm the host answers, and a host line in `agenthost doctor`.
- `agenthost selftest` proves in a few seconds that the installed build works: it starts the built server with no display, opens a local form in headless Chrome, fills it with `see`, `type` and `click` by number, and checks the result. It prints PASS or FAIL per step, stops at the first failure, exits 1 on any failure, and `--json` returns the steps.
- `browser.own_tabs` now lists the tabs of the person's own browser. The extension protocol has a `tabs` request. The extension, the native host (through `allowed-hosts.json`) and the MCP tool (through `policy.toml` site rules) each keep only tabs on allowed hosts. Each tab is reported as tab id, hostname and title cut to 80 characters, never a URL or page content.
- `agenthost shortcut status|install|remove` adds a GNOME custom keyboard shortcut (default Ctrl+Shift+Alt+Esc) that runs `agenthost agent stop` through a small wrapper in `~/.agenthost/bin`. It writes the stop file directly, so it works even if the host hangs. Preview by default; `--apply` changes it. Other desktops get the manual steps.
- Added an opt-in host service (`AGENTHOST_HOST=1`): MCP clients connect through a thin shim to one per-user host over a private Unix socket. State-changing calls take a single host-wide lease with a 30 s busy limit, and `agenthost host status|start|stop` manages the host. The default in-process server is unchanged.
- Added `agenthost journal show` and `agenthost journal save <name>`: the steps the agent took through numbered actions can be saved as a parameterized workflow after review. Typed text is never recorded; it becomes a parameter.
- Numbered actions say what changed in the window's controls, in words (`field "Name" now reads "Ada"`, `dialog "Confirm" went away`). The check uses the accessibility outline; the pixel check is a secondary signal and the fallback when the outline is empty, unsupported, slow or from another window.
- Added `browser.own_snapshot`, `own_click`, `own_type`, `own_select`, `own_navigate`, `own_read` and `own_tabs`: the MCP server can use the browser extension, limited to hosts that `policy.toml` allows by a `site` rule. Typed text is never logged. `own_tabs` is unsupported until the extension can list tabs.
- Added `agenthost viewer start|stop|status`, a small live view of the background display with Pause, Resume and Stop. Background placement is still off by default.
- Added a benchmark suite of 25 headless-Chrome tasks (`npm run benchmark:suite`). It reports success, tool calls, result bytes and seconds per task, writes `benchmarks/suite/results/latest.json`, and fails when the success rate is below 0.9 or any success is unverified.
- Capability grants are removed. A non-empty `grants` array in `config.json` now fails loading with a message pointing to `policy.toml`; an empty array or no key still loads.
- The built-in communication-read allowance is now explicit code (`communicationInspectionAllowed`): observe, inspect and file reads in communication apps up to medium risk. Sends and external effects still need exact confirmation.
- Vision no longer accepts images outside the screenshots and outputs folders. The `granted_path` source is gone.
- The tool manifest no longer lists `policy.list_grants`, `policy.explain_decision` or `forge.*`. A test checks the manifest against the tools the server registers.
- `agenthost replay build|list|open|delete` writes a single-session HTML page from the audit log. It holds summaries only: no screenshots and no typed text.
- A browser extension and native messaging host (`packages/browser-extension`) for sites the person allows in their own browser. It refuses password, one-time-code and card fields and never reads cookies or storage. It is not connected to the MCP server yet.
- The host service design is written (`docs/notes/host-service-design.md`). No code yet.
- Removed phone approvals (pairing, the phone bridge and the phone command). Old config files with a phone key still load.
- "Always allow here" on approval prompts. The approval card has a third button, chat has an "Always allow this kind of action in this app" checkbox, and `agenthost confirm <id> --always` does the same from a terminal. Each approves the action once and writes one `allow` rule to `policy.toml` for the app (and site) and action. It is refused, with a reason, for `any`, navigate, type and click, unknown apps, blocked actions and duplicates. The card button accepts only a physical press, like Approve.
- `agenthost policy list|add|remove`: see rules with their line numbers (a parse error is shown with its line), add a rule and remove one by line. Add and remove preview unless `--apply` is given; writes are atomic and validated.
- Confirmations now record what they are about (`policyTarget`). Shell commands that edit `policy.toml` or run `agenthost policy add|remove` are blocked.
- Fixed: removing the last rule from `policy.toml` dropped the file's final newline.
- One perception tool and a short default tool list. `see` returns the controls of a window as numbered lines (`[1] button "Save"`, `[5] password field (blocked)`), from the agent's browser page, the accessibility tree or OCR, with an optional picture that has the numbers drawn on it (`picture: "marked"`). `click`, `type`, `key`, `scroll`, `drag`, `open`, `windows`, `wait`, `ask`, `steps` and `status` take a number from `see` and call the existing tools through the same governed path, so previews, confirmation tokens, stop and pause gates and the audit log apply as before. Numbers expire after five minutes and are refused when the window moved.
- New config key `tools.profile` (`desktop` by default, `full`; environment `AGENTHOST_TOOLS_PROFILE`). The desktop profile lists 14 tools (9.9 KB of `tools/list` instead of 49 KB for the full list of 82). Every old tool name still works in both profiles, so saved workflows and `computer.run_steps` plans are unchanged; calling a hidden tool directly adds a note naming the tool to use. `agenthost://capabilities` and `agenthost capabilities --markdown` follow the profile. `scripts/measure-tools.mjs` prints the numbers.
- Browser snapshots now use the text of a `<label for=...>` as an input's name when it has no `aria-label`.
- `skills/agenthost/SKILL.md` is rewritten around the loop: `see`, act by number, `see` again.
- Windows accessibility through UI Automation (`packages/os-windows`): `ui.tree`, `ui.find`, `ui.activate`, `ui.set_text`, `screen.read`, label clicks, `set_field` read-back and `guide.show` labels now work on Windows with the same results as on Linux. Password fields are never read or written, administrator windows are refused, a hung app returns a partial result instead of hanging, and there is no OCR fallback on Windows. Not yet run on a Windows machine: `scripts\windows-desktop-check.ps1`.
- Windows packaging (W4, untested on Windows): `scripts/install.ps1` installs the release under `%LOCALAPPDATA%\AgentHost` with SHA-256 check, a `current` junction, an `agenthost.cmd` launcher and a user `Path` entry; no administrator rights. `npm run release:build:windows` builds `agenthost-v<version>-win-x64.zip` (and `agenthost-win-x64.zip`) with Node only.
- `agenthost update --archive <file>.zip` unpacks a Windows release with a built-in zip reader (no external tool) and switches it by junction; `--rollback` swaps the junctions back.
- Windows config lives in `%APPDATA%\agenthost\config.json`. Linux paths are unchanged.
- Client integrations on Windows write `cmd /c agenthost start` (also for Codex `notify`), accept a byte order mark and CRLF files, and Claude Code's `CLAUDE_CONFIG_DIR`. The Claude `PostToolUse` hook on Windows is a plain `agenthost attention clear --restore` instead of a POSIX shell guard.
- `agenthost schedule add|list|remove` use Task Scheduler (`schtasks.exe`) on Windows, with the same flags, preview by default, and validated names.
- Guide mode can wait for the person's click: `guide.show` takes `waitForClick` and `waitSeconds`, blocks until a press inside a box, clears the marks and reports which step was clicked, so the agent keeps its turn. Stop now removes the guide marks, and the stopped task card has a Resume button that clears the stop flag.
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
- Windows desktop adapter (`packages/os-windows`, W2 part 1): windows, screenshots, mouse, keyboard, clipboard and idle time through a PowerShell helper; focus drift re-activation; administrator windows refused as `elevated_window`. Accessibility tools came in a later entry. Not yet run on a Windows machine: `scripts\windows-desktop-check.ps1`.
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
