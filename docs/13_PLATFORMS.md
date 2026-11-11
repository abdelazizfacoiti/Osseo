# Platforms and session types

What AgentHost can control, by operating system and session. Run
`agenthost doctor` to see this for the current machine (`desktopPlatform`).

| Host | Session | Control | Verified |
|---|---|---|---|
| Linux | X11 | Full: windows, input, screenshots, cards, accessibility | Daily use |
| Linux | Wayland + XWayland | X11 (XWayland) windows only: list, focus, type, click, screenshot, cards | Headless GNOME compositor with `Xwayland` |
| Linux | Native Wayland, no XWayland | None directly. Use `execution.placement: "background"` (Xephyr) | Headless GNOME compositor |
| Linux | Headless | Only tools that need no display | Yes |
| Windows | Native desktop (W2) | Windows, mouse, keyboard, screenshots, clipboard and accessibility (Windows UI Automation: `ui.*`, `screen.read`, label clicks, `set_field` read-back, `guide.show` labels) through a PowerShell helper (`packages/os-windows`); headless tools as in W1. No OCR fallback; windows running as administrator are refused (`elevated_window`) | Not yet verified on a Windows machine: run `scripts\windows-desktop-check.ps1` |
| macOS | Native | Not implemented: desktop tools fail with `unsupported_platform` | No |

Tools that do not touch the desktop (files, shell, tasks, workflows, memory,
handoff, scheduling, `browser.*` where Chrome is installed) are not gated by the
desktop adapter.

## Windows desktop (W2)

`packages/os-windows` fills the same contract as the Linux adapter. TypeScript holds the logic; one
long-lived `powershell.exe -STA` process (`helper-script.ts`) compiles a small C# class and answers
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
- **Accessibility (UI Automation):** the helper compiles a second C# class that uses
  `System.Windows.Automation` (control view). It is loaded on its own, so if it fails the rest of the helper
  still works and the accessibility tools report why. Each request runs on a worker thread with a deadline
  (8 s); a hung app returns what was read with `truncated`, never a hang. Elements are found again on every
  call from an id made of the window handle, a child-index path and a hash of role and name (no COM object is
  kept between calls). Roles use the Linux names (`push button`, `entry`, `check box`, `link`, `menu item`,
  `page tab`, `list item`, `combo box`, `label`, `password text`). Password controls and credential-looking
  edit fields are `sensitive`: their text is never read and `ui.set_text` refuses them. Invoke, then Toggle,
  then SelectionItem, then ExpandCollapse are tried for `ui.activate`. A window of an administrator process is
  refused (`elevated_window`). Chrome and Edge expose page controls only once a UI Automation client has asked
  (they switch accessibility on by themselves); other apps (games, custom-drawn UIs) may expose nothing.
- **Not yet:** OCR for label clicks, an overlay and approval cards (W3), the `ffmpeg`-free inline JPEG (screenshots
  work, but inline images need `ffmpeg` on PATH for now).
- **Check it:** `powershell -ExecutionPolicy Bypass -File scripts\windows-desktop-check.ps1`. It drives
  a test window it creates, never your own apps. `-ElevatedProbe` checks the administrator refusal.

## Windows packaging (W4)

Added, and not yet run on a Windows machine. What exists:

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
- **Not done.** Attention hooks record a request but cannot raise a window on Windows (W3). The Python
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
- **Desktop portal screenshots** need a one-time permission prompt, and
  `gnome-screenshot` already works for the screenshot tool on GNOME.
- **AT-SPI** can list apps and windows on Wayland but not screen coordinates for
  most toolkits.

Until then, the supported ways to work with native Wayland apps are the nested
display (`execution.placement: "background"`) or an X11 login.

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
