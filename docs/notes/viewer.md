# Background viewer (Phase 4, part 1)

A small window on the person's own screen that shows the agent's nested display.

- `osseo viewer start [--display :N]` launches `packages/app-overlay/runtime/viewer.py` (GTK 3) and an internal frame loop (`osseo viewer frames`), both detached. One viewer at a time (`run/viewer.pid`, mode 0600).
- `osseo viewer stop` writes `run/viewer.stop`; the window and the loop exit. `status` reports the PID and removes a PID file whose process is gone.
- Frames: `captureDisplayFrame` (`packages/os-linux/src/viewer-frames.ts`) runs `scrot` with `DISPLAY` set, no shell, with a timeout, and writes `run/viewer/frame.png` (directory 0700, file 0600, atomic rename). The window only reads that file, about every 500 ms. Nothing is logged except timings.
- Buttons: Pause (`osseo agent pause`), Resume (`agent resume --pause`), Stop (`agent stop`), fixed argument lists, no shell. A press counts only as a pointer click; injected XTEST clicks are ignored, and Resume needs proof of real hardware like the card buttons. Buttons take no keyboard focus. The window never writes run-state files.
- Status line comes from `run/stop.requested`, `run/takeover.active`, `run/pause.requested`.
- The default stays `execution.placement: "foreground"`. Background is still opt-in.
- The server does not yet write the nested display to a file, so `start` needs `--display` unless `run/background-display.json` (`{ "display": ":90" }`) exists.
