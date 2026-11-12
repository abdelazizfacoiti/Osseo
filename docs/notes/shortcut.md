# Stop shortcut (GNOME)

`agenthost shortcut status | install [--binding <accelerator>] [--apply] | remove [--apply]`

A GNOME custom keyboard shortcut runs `~/.agenthost/bin/agenthost-stop`, a 0700 sh wrapper with one line: `exec '<node>' '<cli>' 'agent' 'stop' '--reason' 'shortcut'`. That writes `run/stop.requested` directly, so Stop works when the host is hung. Default key: `<Control><Shift><Alt>Escape`.

- Preview is the default and calls nothing. `--apply` writes the wrapper and sets gsettings.
- GNOME only (`XDG_CURRENT_DESKTOP` contains GNOME and `gsettings` is on PATH). Anything else fails with `unsupported_desktop` and the manual steps; nothing is touched.
- Keys: schema `org.gnome.settings-daemon.plugins.media-keys`, key `custom-keybindings` (our path is appended, other entries kept); slot `.../custom-keybindings/agenthost-stop/` with `name`, `command`, `binding`.
- Install twice is a no-op. If our slot holds a different command, install refuses (`binding_conflict`) and changes nothing.
- Remove drops only our path from the list, resets our three keys, deletes the wrapper.
- Not covered by tests: a real GNOME session (the key firing, a conflict with another app's shortcut).
