# Platforms

`osseo doctor` shows what works on the current machine.

| System | Session | Status |
|---|---|---|
| Linux x86_64 | X11 | **Supported.** Windows, keyboard and mouse, screenshots, accessibility, OCR, side panel and cards. |
| Linux x86_64 | Wayland with XWayland | Supported for XWayland windows (most apps). Native Wayland windows cannot be listed or driven. |
| Linux x86_64 | Native Wayland only | Experimental: `OSSEO_WAYLAND_PORTAL=1` sends input and screenshots through the desktop portal after one consent; not yet tested on a real Wayland login. Alternative: `execution.placement: "background"` (a separate X display). |
| Linux | No display | Tools that need no screen: files, shell, the agent's headless browser, tasks, workflows. |
| Windows 10/11 | Desktop | **Experimental.** Microsoft Defender currently blocks desktop control (see below). The agent's own browser works. Cards are off unless turned on (`install-from-source.ps1` turns them on); no OCR yet. |
| macOS | | Not started. Desktop tools answer `unsupported_platform`. |

## Linux packages

`osseo setup deps` lists what is missing and installs it with `--apply`. The full list is in
[`requirements-linux.txt`](../requirements-linux.txt): `xdotool`, `wmctrl`, `x11-utils`, `scrot`, `ffmpeg`,
`tesseract-ocr`, `xclip`, `python3-gi`, `python3-pyatspi` (the accessibility tree), `libnotify-bin`, `xinput` and
`xserver-xephyr` (the background display). Chrome or Chromium is used for the agent's own browser.

## Windows and Microsoft Defender

Windows, mouse, keyboard, screenshots, clipboard and window reading all go through one PowerShell helper,
`windows-helper.ps1`. On a fresh Windows 11 with Defender definitions of 27 November 2026, Defender's script scan
refused it as `HackTool:PowerShell/EmpireGetScreenshot.C`: the screenshot code resembles a module of the Empire
attack toolkit. While it is blocked, none of the desktop tools work. Files, shell and the agent's own browser do.
`osseo doctor` and `osseo setup guide` say so (`helper_blocked_by_antivirus`).

The desktop checks passed on Windows 11 on 16 November 2026, on a different machine. Keep your antivirus on and do
not add an exclusion for Osseo: a tool that reads the screen and sends input should stay open to inspection.

## Known limits

- Apps with no accessibility tree (Blender, games, some custom-drawn tools) are read by OCR and clicked by position:
  it works, but it is slower and less exact than numbered controls.
- Password, one-time-code and card fields are never typed into, on any platform.
- Windows does not let a normal process send input to an administrator window; UAC prompts and the lock screen are
  for the person.

Engineering detail on the Windows port and session types: [notes/windows-port.md](notes/windows-port.md).
