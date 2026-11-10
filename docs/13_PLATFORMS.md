# Platforms and session types

What AgentHost can control, by operating system and session. Run
`agenthost doctor` to see this for the current machine (`desktopPlatform`).

| Host | Session | Control | Verified |
|---|---|---|---|
| Linux | X11 | Full: windows, input, screenshots, cards, accessibility | Daily use |
| Linux | Wayland + XWayland | X11 (XWayland) windows only: list, focus, type, click, screenshot, cards | Headless GNOME compositor with `Xwayland` |
| Linux | Native Wayland, no XWayland | None directly. Use `execution.placement: "background"` (Xephyr) | Headless GNOME compositor |
| Linux | Headless | Only tools that need no display | Yes |
| Windows | Native desktop (W2) | Windows, mouse, keyboard, screenshots, clipboard through a PowerShell helper (`packages/os-windows`); headless tools as in W1. No accessibility tools (`ui.*`, label clicks, `set_field` read-back) yet; windows running as administrator are refused (`elevated_window`) | Not yet verified on a Windows machine: run `scripts\windows-desktop-check.ps1` |
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
- **Not yet:** UI Automation (`ui.*`, label clicks, `set_field` read-back report that accessibility is
  unavailable), OCR, an overlay and approval cards (W3), the `ffmpeg`-free inline JPEG (screenshots
  work, but inline images need `ffmpeg` on PATH for now), and packaging (W4).
- **Check it:** `powershell -ExecutionPolicy Bypass -File scripts\windows-desktop-check.ps1`. It drives
  a test window it creates, never your own apps. `-ElevatedProbe` checks the administrator refusal.

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
cards, accessibility), elevated (UAC) windows and the secure desktop (they cannot
be controlled from a normal process), macOS, scheduling through Task Scheduler,
and the installer (W2 to W4 in the plan).

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
