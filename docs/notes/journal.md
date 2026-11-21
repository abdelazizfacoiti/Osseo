# Session journal ("save what you just did")

The server keeps one journal per session at `<agentHome>/journal/<sessionId>.json` (directory 0700, file 0600, atomic write). Each successful `click`, `type` or `key` (not previews, not refusals) adds a step: time, tool, number, the element's role and name from the stored `see` view, and for `type` the parameter name (`text_1`, `text_2`, ...) and the text length. Typed text is never stored. A sensitive or unnamed target, or a single-character `key`, is not recorded and counts in `skipped`. At most 200 steps are kept (`truncated` is set when older ones drop). Files older than 7 days are removed when a new journal starts.

Not journaled: `scroll`, `drag`, direct `desktop.*`/`browser.*` calls, clicks by x,y, and typing without a number. The person's own clicks are not recorded (a separate decision: it needs global input capture).

## Saving

    osseo journal show [--session <id>]
    osseo journal save <name> [--session <id>] [--last <n>] [--description <text>] [--apply]

`save` previews unless `--apply`. A saved workflow has at most 20 steps; use `--last` to keep the final steps of a longer journal. Names are the workflow names (`a-z`, `0-9`, `_`, `-`, 2-49 characters). Replay uses names, not numbers: a click becomes `desktop.click` with `label` and `role`, a type step `desktop.set_field` with `text: "{{text_1}}"`, a key step `desktop.hotkey`. Run it with `osseo workflow run <name> --param text_1=...`. Browser-page elements replay through accessibility labels, which Chrome exposes only with accessibility enabled.
