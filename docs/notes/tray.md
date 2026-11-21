# Tray icon (Phase 3)

`osseo tray start|stop|status` runs `packages/app-overlay/runtime/tray.py`, a StatusNotifierItem
(`org.kde.StatusNotifierItem` at `/StatusNotifierItem`, bus name `org.kde.StatusNotifierItem-<pid>-1`)
written with python3 Gio/GLib. It registers with `org.kde.StatusNotifierWatcher` and registers again if the
watcher restarts or appears later. GNOME shows it only with the AppIndicator extension; KDE shows it natively.

- Properties: Id `osseo`, Category `ApplicationStatus`, Title `Osseo`, Status `Active` or
  `NeedsAttention` (approval waiting), IconName from the state, ToolTip text.
- State, read every 2 s: `run/stop.requested` (stopped), `run/pause.requested` (paused),
  `run/activity.json` with `phase: finished, outcome: approval_required` (waiting for approval), else running.
- Activate (left click) and ContextMenu show a `Gtk.Menu` at the pointer (no DBusMenu): Stop, Pause, Resume,
  Open viewer, Quit tray. Each action runs a fixed list without a shell: `node <entry> agent stop`,
  `agent pause`, `agent resume --pause`, `viewer start`. Stop, Pause and Resume refuse injected (XTEST) input
  like the viewer; Resume needs a physical device.
- The tray reads the run files only. The CLI writes `run/tray.pid` (0600); the tray removes it on exit.
- Exit: SIGTERM, SIGINT or `tray.py --agent-home <dir> --quit` (signals the PID in the file). Quitting releases
  the bus name, which unregisters the item.

Tests: `packages/osseo-cli/src/__tests__/tray.test.ts` (PID file logic, spawn stubbed) and
`packages/app-overlay/src/__tests__/tray.test.ts` (argument lists; a private `dbus-run-session` bus with a fake
watcher). Checked on the real session (GNOME, Ubuntu AppIndicator extension installed): `osseo tray start` registered `org.kde.StatusNotifierItem-<pid>-1` with the session's `org.kde.StatusNotifierWatcher`, the watcher listed it next to the system's own items, and `tray stop` removed it again. A screenshot of a GNOME test session's top bar, running the same Ubuntu AppIndicator extension, showed the Osseo icon (the info glyph of the running state). Your own top bar was not looked at. Not tested: KDE, the Gtk menu itself, or real hardware presses on the menu
presses on it. The physical-input rules of `on_item` are tested with a fake `viewer` module: a synthetic press runs only Open viewer, and Resume needs `physical_source`.
