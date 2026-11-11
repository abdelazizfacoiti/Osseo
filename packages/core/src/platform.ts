/*
 * What AgentHost can control on this machine, stated plainly. The desktop
 * layer is per-OS: `os-linux` implements the contract below today. A Windows
 * or macOS adapter would implement the same LinuxAutomation-shaped contract
 * (see docs/13_PLATFORMS.md) and report itself here.
 */

export type HostOs = "linux" | "windows" | "macos" | "other";
export type DesktopSessionKind = "x11" | "xwayland" | "wayland" | "headless" | "native-windows" | "native-macos" | "unknown";
export type ControlLevel = "full" | "x11-windows-only" | "none";

export interface DesktopPlatformReport {
  os: HostOs;
  session: DesktopSessionKind;
  /** Direct control of windows, input, and screenshots on this machine. */
  control: ControlLevel;
  /** What works, what does not, and what to do about it. */
  guidance: string[];
}

export function describeDesktopPlatform(input: { platform?: NodeJS.Platform; env?: Record<string, string | undefined> } = {}): DesktopPlatformReport {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (platform === "win32") {
    return {
      os: "windows", session: "native-windows", control: "full",
      guidance: [
        "Windows desktop control (windows, mouse, keyboard, screenshots, clipboard) and accessibility (ui.*, screen.read, label clicks, set_field read-back, through Windows UI Automation) run through a PowerShell helper. None of it has been verified on a real Windows machine yet: run scripts\\windows-desktop-check.ps1.",
        "Windows that run as administrator reject input and UI Automation and are refused; UAC prompts and the lock screen cannot be automated; there is no OCR fallback for label clicks on Windows, so a control that exposes no UI Automation name needs a screenshot and coordinates."
      ]
    };
  }
  if (platform === "darwin") {
    return { os: "macos", session: "native-macos", control: "none", guidance: ["macOS desktop control is not implemented yet. File, shell, workflow, memory, and handoff tools that do not touch the desktop still work.", "A macOS adapter must implement the platform contract in docs/13_PLATFORMS.md."] };
  }
  if (platform !== "linux") return { os: "other", session: "unknown", control: "none", guidance: ["This operating system is not supported."] };

  const session = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  const display = Boolean(env.DISPLAY);
  const wayland = Boolean(env.WAYLAND_DISPLAY);
  if (session === "x11" || (session === "" && display && !wayland)) {
    return { os: "linux", session: "x11", control: "full", guidance: [] };
  }
  if (session === "wayland" || wayland) {
    if (display) {
      return {
        os: "linux", session: "xwayland", control: "x11-windows-only",
        guidance: [
          "Wayland session with XWayland: windows, input, screenshots, and cards work for X11 (XWayland) apps only. Native Wayland windows are invisible to them.",
          "To control native Wayland apps, set execution.placement to background (needs Xephyr): AgentHost then starts the apps it works on inside a nested X display.",
          "For full desktop control, log in to an X11 session."
        ]
      };
    }
    return {
      os: "linux", session: "wayland", control: "none",
      guidance: [
        "Native Wayland without XWayland: direct window, input, and screenshot control is unavailable, and no overlay can be shown.",
        "Set execution.placement to background (needs Xephyr) to work inside a nested X display, or log in to an X11 session."
      ]
    };
  }
  if (!display) return { os: "linux", session: "headless", control: "none", guidance: ["No graphical session is available: only tools that do not need a display work."] };
  return { os: "linux", session: "x11", control: "full", guidance: [] };
}
