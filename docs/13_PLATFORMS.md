# Platforms and session types

What AgentHost can control, by operating system and session. Run
`agenthost doctor` to see this for the current machine (`desktopPlatform`).

| Host | Session | Control | Verified |
|---|---|---|---|
| Linux | X11 | Full: windows, input, screenshots, cards, accessibility | Daily use |
| Linux | Wayland + XWayland | X11 (XWayland) windows only: list, focus, type, click, screenshot, cards | Headless GNOME compositor with `Xwayland` |
| Linux | Native Wayland, no XWayland | Opt-in: `AGENTHOST_WAYLAND_PORTAL=1` sends input and screenshots through the desktop portal after one consent (not yet run on a real Wayland login). Otherwise `execution.placement: "background"` (Xephyr) | Headless GNOME compositor |
| Linux | Headless | Only tools that need no display | Yes |
| Windows | Native desktop (W2) | Windows, mouse, keyboard, screenshots, clipboard and accessibility (Windows UI Automation: `ui.*`, `screen.read`, label clicks, `set_field` read-back, `guide.show` labels) through a PowerShell helper (`packages/os-windows`); headless tools as in W1. No OCR fallback; windows running as administrator are refused (`elevated_window`) | Verified on Windows 11 Pro 10.0.26200 (2026-11-16): `scripts\windows-desktop-check.ps1` 32 of 32 |
| macOS | Native | Not implemented: desktop tools fail with `unsupported_platform` | No |

Tools that do not touch the desktop (files, shell, tasks, workflows, memory,
handoff, scheduling, `browser.*` where Chrome is installed) are not gated by the
desktop adapter.

## Windows desktop (W2)

`packages/os-windows` fills the same contract as the Linux adapter. TypeScript holds the logic; one
long-lived `powershell.exe -STA` process (`helper-script.ts`) emits its Win32 bindings in memory (`native-ps.ts`: no C# compile, no DLL written) and answers
JSON lines on stdin and stdout, like the GTK renderer on Linux. Nothing is installed.

- **Windows:** `EnumWindows` (visible, titled, not cloaked), frame bounds from DWM, `SetForegroundWindow`
  with a thread-attach. Window ids are decimal handles; `0x` hex is accepted.
- **Screenshots:** GDI `CopyFromScreen` of the virtual screen, the active window, or a region, with
  scale, PNG or JPEG. The process is DPI-aware, so coordinates are physical pixels.
- **Input:** `SendInput` for mouse (click, double, right, scroll, drag) and keys (virtual-key chords
  with repeat). Text is pasted through the clipboard; the old clipboard text returns after a 350 ms
  minimum wait and the same settle check as Linux. If the clipboard held no text (an image), it is
  cleared afterwards rather than left holding the pasted text.
- **Focus drift:** a pinned window id that is not in front is re-activated once, then refused.
- **Elevated windows:** Windows drops input from a normal process to an administrator window (UIPI).
  The helper checks the target's token first and refuses with `elevated_window`. UAC prompts and the
  lock screen cannot be automated; hand those to the person.
- **Accessibility (UI Automation):** the helper loads the UI Automation assemblies (no compile) and runs a PowerShell worker (`uia-script.ts`) that uses
  `System.Windows.Automation` (control view). It is loaded on its own, so if it fails the rest of the helper
  still works and the accessibility tools report why. Each request runs on a worker thread with a deadline
  (8 s); a hung app returns what was read with `truncated`, never a hang. A window root is found with a desktop `FindFirst` by its handle: `AutomationElement.FromHandle` returned WinForms children as generic panes (`Pane`, no buttons or edit boxes), so it is only the fallback. Elements are found again on every
  call from an id made of the window handle, a child-index path and a hash of role and name (no COM object is
  kept between calls). Roles use the Linux names (`push button`, `entry`, `check box`, `link`, `menu item`,
  `page tab`, `list item`, `combo box`, `label`, `password text`). Password controls and credential-looking
  edit fields are `sensitive`: their text is never read and `ui.set_text` refuses them. Invoke, then Toggle,
  then SelectionItem, then ExpandCollapse are tried for `ui.activate`. A window of an administrator process is
  refused (`elevated_window`). Chrome and Edge expose page controls only once a UI Automation client has asked
  (they switch accessibility on by themselves); other apps (games, custom-drawn UIs) may expose nothing.
- **Not yet:** OCR for label clicks, the `ffmpeg`-free inline JPEG (screenshots work, but inline images need
  `ffmpeg` on PATH for now). The overlay (W3) is built behind `AGENTHOST_WINDOWS_OVERLAY=1`; see below.
- **Check it:** `powershell -ExecutionPolicy Bypass -File scripts\windows-desktop-check.ps1`. It drives
  a test window it creates, never your own apps. `-ElevatedProbe` checks the administrator refusal.

## Windows overlay (W3)

Built and opt-in. The safety guard and the dock passed on Windows 11 Pro 10.0.26200 on 2026-11-16 (see Check it below). With `AGENTHOST_WINDOWS_OVERLAY=1` the server draws the
action, task and approval cards with WPF, in one Windows PowerShell process that speaks the same protocol as
the Linux renderer. Without the variable nothing changes: the headless renderer runs, as before.

- **Buttons need a real press.** The process installs a low-level mouse hook (`WH_MOUSE_LL`) and marks each
  left-button event as real or injected. A button acts only when its own press and release were real. Keyboard
  activation, UI Automation invoke and the agent's own clicks (SendInput) are refused. Approve, Always allow,
  Deny, Pause, Resume, Stop and Continue all go through this check. If the hook cannot be installed, the overlay
  stays off and reports `overlay_input_guard_unavailable`, so no card with buttons appears.
- **Start-up.** The process starts in the background; a cold PowerShell start can take 10 to 20 seconds. Cards
  appear once it is up. Until then an action shows no card and does not wait for one.
- **Not drawn:** the pointer, ring, highlight, frame and pill primitives. The cards work without them. Cards go
  on the primary display only. A card without buttons passes clicks through.
- **Switch.** The cards turn on with `"windows": true` under `"overlay"` in `config.json`, or with
  `AGENTHOST_WINDOWS_OVERLAY=1`. `overlay.mode` is `always`, `on_change` or `off`; there is no true/false switch for
  it. `agenthost setup guide` says which of these applies on Windows.
- **Dock.** With `overlay.layout` `dock` (the default) the strip on `overlay.dockSide` takes `overlay.dockWidthPercent`
  of the primary display, at least 240 units wide. The shell reserves it the way it reserves the taskbar
  (`SHAppBarMessage`), so maximized windows end at its edge. The timeline card sits at its top, and cards whose
  placement starts with `bottom_` stack up from its floor, with the Linux `dock_layout` numbers. Other cards float
  over the work area. The strip exists only while it holds cards: it is released 2 seconds after the last one goes
  (so a screenshot clear does not resize windows), at once on emergency hide and on close, and by Windows when the
  process dies. `dockReserveSpace: false` draws the strip without reserving space. `rail` is not drawn on Windows,
  so its cards float.
- **Check the dock.** `node scripts\windows-dock-smoke.mjs` needs no click. Last run on Windows 11 Pro 10.0.26200 at
  150% scale, 2026-11-16: 17 passed, 0 failed, exit 0. The work area shrinks by the strip (360 device pixels of
  1920) while the cards are up; the strip and the three dock cards lie inside it; a maximized window ends at its
  edge; dismiss, killing the overlay process, emergency hide and close each give the work area back; a clear keeps
  the reservation through the grace period. The maximized window is a test form, and the agent's own Chrome is maximized too; both end at the strip.
- **Screenshots** clear the cards around each capture, the same suppression as on Linux. The strip keeps its
  reservation through the clear. Not yet checked with a picture of a full display taken under the strip.
- **Check it.** After `npm run build`, run `node scripts\windows-overlay-smoke.mjs`. It asks for one real click
  on the test card's Stop button within 30 seconds, and it checks that a synthetic click is refused.
  Last run, Windows 11 Pro 10.0.26200, 2026-11-16: 10 passed, 0 failed, exit 0. The checks were: the process
  starts and installs the mouse guard; the test card is shown and listed; UI Automation finds the Stop button
  with bounds; a synthetic click on Stop is refused; a real click on Stop is accepted
  (`emergency_stop_requested`); the state lists the card; dismiss removes it; close leaves no card behind.
  The check counts only the card it shows, so a card with the same title from another AgentHost session is ignored.
- **Card look.** Timeline rows show a state glyph (green check for done, blue dot for running, amber circle for waiting,
  red cross for failed), the label in bold with the detail under it, and the time at the right. Status badges are
  tinted pills, key/value rows have a fixed key column, and cards use the Linux gradient and edge. Checked by eye on
  the dock screenshot (2026-11-16), not by a pixel comparison with Linux.
- **Antivirus (history).** On 2026-11-17 Avira quarantined `0shr3uze.dll`, a temporary DLL that PowerShell wrote when it compiled the overlay C# (`Add-Type`). Nothing is compiled now, so no DLL is written and that quarantine cannot recur. The helper, the UI Automation worker, the overlay and the smoke scripts use the same in-memory bindings.
- **Real click, current build.** `windows-overlay-smoke.mjs` on 2026-11-17 after the in-memory port: 9 of 10. The card shows, the synthetic click is refused, state, dismiss and close pass, and the mouse hook installs and receives events (a relative mouse move was counted). No real click on Stop reached the card in that run, and none reached it in five earlier attempts, so this stays open until a person clicks Stop during the run and the event arrives.
- **Verified on Windows (no C#, no DLL), 2026-11-17.** Desktop check 32 of 32, headless check 12 of 12, browser check 6 of 6, numbered-action check 7 of 7, dock check 17 of 17, overlay smoke 9 of 10 (the real click is open). `npm run test:windows` 183 passed, lint clean, and no new DLL in the temp folder for any run. Not yet
  verified on Windows: the rail layout (not drawn on Windows).

## Windows browser (the agent's own Chrome)

`browser.*` drives the agent's own Chrome on a dedicated profile (`~\.agenthost\browser\profiles\agent`), never the
person's profile. `scripts\windows-browser-check.mjs` checks it on Windows: a visible Chrome window opens, a local
form is read by DOM, typed into and submitted, and the confirmation page is reached. Last run, Windows 11 Pro
10.0.26200, 2026-11-16: 6 passed, 0 failed. Chrome is closed afterwards. An earlier `connection_closed` on
`browser.open` (before the BOM and window fixes) did not come back on this build.

`scripts\windows-see-check.mjs` checks the numbered tools through the built MCP server on the same kind of form:
`open`, `see`, `type`, `click` and `wait`. `see` answers from the DOM (source `dom`). Last run, 2026-11-16: 7 passed,
0 failed. `see` on the person's own Chrome still lists only its chrome and tabs; web tasks use `open`, which opens
the agent's browser unless `in: "my-browser"` is given.

## Windows packaging (W4)

Installed on Windows 11 (2026-11-17). The zip is built on Windows from the stage (`npm run release:build -- --stage-only`, then `npm run release:build:windows`); `scripts\install.ps1` with `AGENTHOST_ARCHIVE` installed it into this account, an update to a later release and `update --rollback` switched the release junction, and `agenthost doctor` passes. Not run: a clean user (creating one needs administrator rights), and client registration with the installed release. What exists:

- **Installer.** `scripts/install.ps1` (Windows PowerShell 5.1): checks OS, x64 and Node 20+, takes the
  archive from `AGENTHOST_ARCHIVE`, `AGENTHOST_ARCHIVE_URL` or the latest release
  (`agenthost-win-x64.zip`), always verifies the SHA-256, installs under `%LOCALAPPDATA%\AgentHost`
  with a `current` junction, writes `bin\agenthost.cmd` (and an `agenthost` shim for Git Bash), and adds
  `bin` to the user `Path` only when missing. No administrator rights, no execution-policy change
  (run it with `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`). `-DryRun`, `-Help`.
  Download and read the script before running it; do not pipe it into `iex`.
- **Release zip.** `npm run release:build:windows` (after `release:build`) writes
  `agenthost-v<version>-win-x64.zip` with Node only (`packages/agenthost-cli/src/zip.ts`). The CLI reads
  it the same way: `agenthost update --archive <zip> --apply`. Zip64, encryption and symbolic links are
  refused, and so are names with `..`, `:` or backslashes.
- **Folders.** Config `%APPDATA%\agenthost\config.json`; runtime data `%USERPROFILE%\.agenthost`
  (unchanged, so the W1 access-list rules apply); releases `%LOCALAPPDATA%\AgentHost`.
- **Client integrations.** Same config files as on Linux, under `%USERPROFILE%`; entries run
  `cmd /c agenthost start`. `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` and `XDG_CONFIG_HOME`
  override the roots. A byte order mark in a config file is accepted.
- **Schedules.** `agenthost schedule add|list|remove` use `schtasks.exe` (`/SC DAILY|WEEKLY|MINUTE`),
  task `AgentHost\wf-<name>`, per user, `/F`, preview unless `--apply`. Names must match
  `^[A-Za-z0-9._-]{1,64}$`; parameters containing `" % ^ & | < >` or a line break are refused; the
  command line is limited to 261 characters. A custom `AGENTHOST_HOME` or `AGENTHOST_CONFIG` cannot be
  carried into a task and is refused. The task starts a console window while it runs.
- **Not done.** Attention hooks record a request but cannot raise a window on Windows. The Python
  overlay is not shipped. `doctor` still reports Linux-only checks. Uninstall leaves the `Path` entry and
  any scheduled tasks.
- **Check it.** `scripts\windows-check.ps1` now also runs `install.ps1 -DryRun`; `npm run test:windows`
  includes the zip, layout, junction, schedule and integration tests. For a real install, build the zip on
  Linux and run `$env:AGENTHOST_ARCHIVE = "C:\path\agenthost-win-x64.zip"; powershell -ExecutionPolicy Bypass -File scripts\install.ps1`.

## Windows (headless, W1)

What the Windows port covers today, and what it does not.

- **Server and tools.** The MCP server starts on Windows and answers over stdio.
  Files, tasks, workflows, memory, handoff, and CLI approvals are plain Node and
  work on Windows paths. Desktop tools return `unsupported_platform`.
- **Paths.** The policy follows Windows rules when the host is Windows: drive
  letters and backslashes, case-insensitive comparison, `%NAME%` expansion (with
  standard folder defaults), `~` as the user's home. Protected: drive roots,
  `%SystemRoot%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramData%`;
  credential folders (`.ssh`, `.aws`, `.gnupg`, `.docker`, Windows Credential
  Manager and DPAPI folders); browser profiles (Chrome, Edge, Brave, Firefox,
  Opera). UNC (`\\server\share`) paths are reported as network paths: local
  rules cannot see inside them.
- **Shell.** `shell.run` executes a program with an argument list, as on Linux.
  Windows commands are classified with their own rules: delete commands
  (`del`, `rd`, `Remove-Item`) need approval; disk, boot, and recovery tools,
  machine registry writes, and account changes are blocked; `powershell` and
  `cmd` wrappers, encoded PowerShell, `Set-ExecutionPolicy`, and service and
  scheduled-task changes need approval; elevation (`RunAs`) and download-then-run
  are blocked. Ask for `powershell.exe -NoProfile -Command ...` when a PowerShell
  cmdlet is needed; that asks for approval first.
- **Processes.** A timed-out command and a closed browser end their whole process
  tree (`taskkill /T`, forced with `/F`).
- **Browsers.** `browser.*` finds Chrome in its install folders (Program Files,
  Program Files (x86), per-user) and then Edge, then `chrome.exe` or `msedge.exe`
  on PATH. It drives them over the same DevTools protocol.
- **Files on disk.** POSIX file modes do nothing on Windows. The AgentHost home
  is restricted with an access list instead (`icacls`: inheritance off; only the
  current user and SYSTEM kept). Failure is reported, not hidden.
- **Linux-only start-up work is skipped.** The overlay sweep (`pgrep`, `ps`) and
  the desktop package bootstrap (`apt-get`) do nothing on Windows.

Not done, and not claimed: any desktop control (windows, input, screenshots,
cards, accessibility; the desktop part is W2 above), elevated (UAC) windows and the secure desktop (they cannot
be controlled from a normal process), and macOS. The installer and Task Scheduler
are in the W4 section below, untested.

How it is checked:

- `npm run test:windows`: the unit tests that do not assume Linux (path policy,
  shell classifier, process trees, browser discovery, access lists, and the
  pure result helpers). Run on Windows in CI (`windows-headless`).
- `node scripts/windows-smoke.mjs`: the built server over stdio with a temporary
  AgentHost home: initialize, tools, `system.get_info`, provenance, files, a
  protected file, the `.ssh` folder, `where`/`which`, a PowerShell or `sh`
  wrapper, a delete, headless Chrome or Edge, and tasks. It runs on any OS.
- `scripts\windows-check.ps1`: Node version, install, build, lint, the Windows
  unit tests, and the smoke script, with one PASS or FAIL line per step.

## Why native Wayland windows are not controlled directly

A Wayland compositor gives clients no way to see or drive other clients'
windows. XWayland apps can be driven through X11 tools, but native Wayland apps
cannot. The remaining routes, and why each is not shipped yet:

- **Virtual input device (`/dev/uinput`)** reaches every window on every
  compositor, but how its coordinates map to the screen differs by compositor,
  scale factor, and monitor layout. A wrong mapping clicks the wrong place, which
  is a safety problem, so it must be calibrated and verified on a real Wayland
  session before it ships. It also needs the user in the `uinput` group.
- **Desktop portal (RemoteDesktop and ScreenCast)** gives input and screenshots
  after one consent prompt. It ships as an opt-in path, `AGENTHOST_WAYLAND_PORTAL=1`,
  and the shared screen is its only target; see `docs/notes/wayland-portal.md`.
- **AT-SPI** can list apps and windows on Wayland but not screen coordinates for
  most toolkits.

On a Wayland login, `AGENTHOST_WAYLAND_PORTAL=1` sends input and screenshots
through the desktop portal, after one consent prompt. AgentHost does not list or
focus windows there, and it has not yet been run on a real Wayland login:
`agenthost portal check --start` is the check to run on one. Otherwise, the
supported ways to work with native Wayland apps are the nested display
(`execution.placement: "background"`) or an X11 login.

## Adding a Windows or macOS adapter

The seam is the `LinuxAutomation` interface in
`packages/mcp-server/src/context.ts` (the name is historical). A new package
(for example `os-windows`) implements the same calls and is selected in
`server.ts` by `describeDesktopPlatform()` from `@agenthost/core`:

- window list, focus, and active window (with app name and pid);
- screenshot, click, pointer, hotkey, and type text, each verifying the target
  window first;
- clipboard get and set;
- app and URL launch;
- accessibility tree, if available.

Rules that every adapter must keep: core stays app-agnostic and does not import
the adapter; every desktop call honors an injected environment/context so a
background display can redirect it; and a call that cannot be done fails with a
specific code instead of claiming success.
