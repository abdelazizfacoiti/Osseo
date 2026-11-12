# agenthost selftest

`agenthost selftest [--json]` proves on this machine that the installed AgentHost works end to end, in a few seconds.

It makes a temp directory (mode 0700) with its own `AGENTHOST_HOME`, a config with the overlay off, and a local HTML form (a "Name" field, a "Save" button and a line `<p id="out">` that the button fills with `Saved: <name>`). It starts the built server with `AGENTHOST_TOOLS_PROFILE=full` and DISPLAY and WAYLAND_DISPLAY removed, so the agent's browser runs headless and nothing touches the real screen.

Steps, in order: `initialize`, `open` (the form as a file URL), `see` (Name and Save are listed), `type` into Name by number ("Ada"), `click` Save by number, `see again` (the Name field reads Ada, and the page text reads "Saved: Ada"; static text is not in the numbered list, so the last check reads it through `browser.snapshot`). A failed step stops the run and later steps show as skipped. Exit code 0 when all six pass, 1 otherwise. The server is stopped and the temp directory removed in a `finally`.

Not covered: a real GUI session (X11 or Windows desktop input, overlay cards, approvals). Chrome is found on PATH; the server entry is the one `mcpEntry()` resolves.
