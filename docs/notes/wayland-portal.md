# Wayland portal (Phase 10)

Status: opt-in (`AGENTHOST_WAYLAND_PORTAL=1`). Built and tested here against the installed portal's probe and a fake portal on a private bus. Not yet run on a real Wayland login, because this machine is an X11 session and the consent dialog needs a person.

## What it does

- Input: keyboard and pointer through `org.freedesktop.portal.RemoteDesktop` (`NotifyKeyboardKeysym`, `NotifyPointerMotionAbsolute`, `NotifyPointerButton`).
- Capture: one frame of the shared monitor through `org.freedesktop.portal.ScreenCast` (`OpenPipeWireRemote`) and GStreamer's `pipewiresrc`.
- One consent: `RemoteDesktop.CreateSession` → `SelectDevices` (keyboard and pointer) → `ScreenCast.SelectSources` (monitor, embedded cursor) on the same session → `RemoteDesktop.Start`, which shows the dialog. The `Response` carries the granted devices and streams.
- A refusal is kept for the rest of the process. AgentHost does not ask again until it restarts.
- Reads (window context, window list, bounds, capabilities) never ask. Only click, type, hotkey and screenshot do. A status read that asked would show a consent dialog on the person's screen for no action.

## Where it sits

- `packages/os-linux/src/portal/portal-protocol.ts`: keysyms, button codes, the Wayland test and the opt-in flag. No I/O.
- `packages/os-linux/src/portal/portal-session.ts`: a child process running the helper, with a JSON-lines protocol. A timed-out helper is replaced, and its session goes with it.
- `packages/os-linux/src/portal/portal-desktop.ts`: the adapter override (`click`, `typeText`, `hotkey`, `screenshot`, `getActiveWindow`, `getActiveWindowBounds`, `getScreenGeometry`, `listWindows`, `focusWindow`, `pointer`, `waitForPointerPress`, `getDesktopCapabilities`). Every X11 method that the portal path replaces is replaced here, so nothing falls through to xdotool.
- `packages/os-linux/runtime/portal_helper.py`: holds the DBus connection. The portal ends a session when its caller disconnects, so one helper process owns one session.
- `packages/mcp-server/src/server.ts`: builds the session only when `AGENTHOST_WAYLAND_PORTAL=1`, the session is Wayland, no background display is in use, and `options.linux` is not injected.
- `packages/agenthost-cli/src/portal.ts`: `agenthost portal check [--start]`.

## Why a helper process

The MCP server is Node, and the tree has no DBus binding for Node. The GTK renderer already depends on python3-gi, so Gio runs in a small Python process. Requests go over stdin and stdout as JSON lines.

## Verified here

- The probe against the installed `xdg-desktop-portal` (X11 login, no dialog): RemoteDesktop v2 with `AvailableDeviceTypes` 3, ScreenCast v5 with `AvailableSourceTypes` 7, and `CreateSession` and `Close` succeed. The first probe failed with "Missing token": the portal needs `session_handle_token` in `CreateSession` as well as `handle_token`. That is fixed and tested.
- The full helper against `portal/fake_portal.py` on a private `dbus-run-session` bus. The fake uses the installed portal's method signatures, and GDBus enforces them. Cases: a grant (probe, open, pointer motion, press and release, keysyms, a screenshot that fails cleanly without PipeWire, close), a refusal (the session is closed and further input is refused), no answer (the caller's timeout ends the wait and the session is closed), a malformed line, and an unknown command. The helper never reaches the real session bus (`driver.py` refuses it).
- 33 tests for the protocol helpers, the session (with a Python stand-in for the helper), the desktop override (with a fake session), the CLI check, and the private-bus run.

## Checked on a real GNOME compositor (nested)

`gnome-shell --nested --wayland` ran inside a Xephyr test window (display :41, not :0) on a private `dbus-run-session` bus with its own runtime folder. That gives a real Wayland socket (`ah-wl`) and the real portal services: `org.freedesktop.portal.Desktop` (xdg-desktop-portal), `org.gnome.Mutter.RemoteDesktop` and `org.gnome.Mutter.ScreenCast`.

- `probe` against it: RemoteDesktop v2 (3 device types), ScreenCast v5 (7 source types), a session created and closed.
- `open` with nobody answering: the portal never answered, so the helper returned `portal_timeout` after its limit and closed the session. The consent dialog was not clicked.

## Not verified (needs a person at the consent dialog)

- Granting the consent dialog, then input and capture through the grant. The grant needs a person to click Allow; the agent did not click it.
- `ScreenCast.SelectSources` on a RemoteDesktop session, with the real portal. The spec allows it, and the fake accepts it.
- PipeWire frames. The capture pipeline is built and its error path is tested, but there is no real node here.
- Input through the compositor: the pointer mapping, and keysyms on non-US layouts. Hotkey names map to X11 keysyms.
- Multi-monitor: the first granted stream is used. The desktop tools map picture pixels from (0,0), so a shared monitor that does not start at 0,0 gets a warning in the screenshot result.

## Limits by design

- The shared screen is the one target (`portal-screen`). Verified-action effect checks that need window bounds report what they can.
- Window listing and focus are refused. Pointer actions other than click are refused. Teach waits report unavailable (AgentHost cannot see pointer presses on Wayland).
- Screenshots are full screen only: no region and no scale.

## How to finish the grant check

The nested session from the check above is still running on display :41 when this note was written. Its bus address is in `/tmp/ah-xdg-wl/bus`. Then, from the repository:

```sh
DBUS_SESSION_BUS_ADDRESS="$(cat /tmp/ah-xdg-wl/bus)" XDG_RUNTIME_DIR=/tmp/ah-xdg-wl WAYLAND_DISPLAY=ah-wl \
  node packages/agenthost-cli/dist/index.js portal check --start
```

A consent dialog appears inside the nested shell window on :41. Click Allow to test the grant, or Cancel to test the refusal. To stop the session, run `pkill -f "wayland-display=ah-wl"` and close the "AgentHost test screen" window.

On a real Wayland login, the same check works without the nested session:

## To check on a Wayland login

1. `agenthost portal check` (no dialog), then `agenthost portal check --start`. Confirm the dialog, the granted device types, and the stream's position and size.
2. Start a client with `AGENTHOST_WAYLAND_PORTAL=1`. Take `desktop.screenshot`, then click a harmless target and type into a text editor. Check that each action lands where it should.
