# Platforms and session types

What AgentHost can control, by operating system and session. Run
`agenthost doctor` to see this for the current machine (`desktopPlatform`).

| Host | Session | Control | Verified |
|---|---|---|---|
| Linux | X11 | Full: windows, input, screenshots, cards, accessibility | Daily use |
| Linux | Wayland + XWayland | X11 (XWayland) windows only: list, focus, type, click, screenshot, cards | Headless GNOME compositor with `Xwayland` |
| Linux | Native Wayland, no XWayland | None directly. Use `execution.placement: "background"` (Xephyr) | Headless GNOME compositor |
| Linux | Headless | Only tools that need no display | Yes |
| Windows | Native | Not implemented: desktop tools fail with `unsupported_platform` | No |
| macOS | Native | Not implemented: desktop tools fail with `unsupported_platform` | No |

Tools that do not touch the desktop (files, shell, tasks, workflows, memory,
handoff, scheduling, `browser.*` where Chrome is installed) are not gated by the
desktop adapter.

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
