# Speed plan: smooth, fast, reliable desktop actions

**Status: APPROVED 2026-11-18, in progress.** Progress is recorded at the end of this file.

Goal: any desktop app (a browser, a design tool, an API client, an editor) feels smooth to drive, without
losing what makes AgentHost trustworthy: verified effects, approvals, Stop, audit. Measure before and after
with the same commands.

## Baseline (2026-11-18, this Linux machine, tool time only, model time excluded)

`npm run benchmark:form`, three runs, all routes correct, no failed or unverified calls:

| Route | Calls | Seconds (median) | Per call |
|---|---|---|---|
| pixel-before (old desktop path) | 19 | 16.7 | 0.88 s |
| pixel-after (current desktop path) | 9 | 13.0 | 1.45 s |
| numbered (agent's own browser, DOM) | 9 | 4.2 | 0.47 s |
| browser (browser tools directly) | 6 | 1.6 | 0.27 s |

Seen in live runs: a desktop key about 1.0 to 1.5 s, a click 2 to 3.5 s, `see` 2 to 7 s when the app has no
accessibility tree (screen text recognition), typing short text 2 to 4 s (clipboard paste).

## Targets

| Measure | Now | Target |
|---|---|---|
| pixel-after route | 13.0 s | 6.5 s or less (half) |
| one desktop key or click, verified | 1.0 to 3.5 s | under 0.5 s |
| a 20-key sequence | about 25 s (one call per key) | under 2 s |
| `see` on an app with no accessibility tree | 2 to 7 s | under 1.5 s on repeat views |
| reliability | 0 failed, 0 unverified | unchanged: 0 failed, 0 unverified |

## Phase 0: measure exactly (no behaviour change)

- New `npm run benchmark:desktop-actions`: on a nested display, with a small test app, time 20 clicks, 20 keys,
  a 20-key sequence, 5 typed fields, `see` on an accessible window and `see` through text recognition. Report
  median and p90 per action and the share of each phase.
- Use the existing `AGENTHOST_TRACE=1` phase traces (overlay, safety, preview, handler, settle, audit) to split
  each action's time. Output: a table of where the 1.45 s goes.
- Decide the order of phases 1 to 5 from that table, not from guesses.

## Phase 1: verify smarter, not on every keystroke

- Today every click, key and type captures the window before and after and waits about 0.5 s for it to settle.
- Change: inside a sequence or plan, verify once at the end (or at steps marked `expect`), not after each key.
- Settle adaptively: stop waiting as soon as two captures match (often under 100 ms), with the current 0.5 s as
  the ceiling, not the default.
- Keep: a single standalone action still reports `effect.screenChanged`; nothing is reported verified that was
  not checked.

## Phase 2: one long-running desktop helper on Linux

- Today each action starts several short programs (window checks, key sending, screenshots, clipboard).
- Change: one helper process per session (as the Windows adapter already does), keeping the X connection open
  and answering window, input, capture and clipboard requests over a pipe.
- Fallback: if the helper fails, the current per-command path is used, so reliability does not depend on it.

## Phase 3: faster typing

- Today all text goes through the clipboard (save, set, paste, restore), because direct typing swapped letters
  on AZERTY.
- Change: type plain text directly with a layout-aware key map (the helper knows the keyboard layout), use the
  clipboard only for text the layout cannot type, and keep the read-back check.

## Phase 4: faster screen reading for apps without an accessibility tree

- Cache text recognition per region; on the next `see`, re-read only the parts of the window that changed.
- Run recognition on a downscaled, cropped image of the window, not the whole screen.
- Keep accessibility first whenever the app exposes it.

## Phase 5: batched plans by default

- Let `steps` (and `sequence` for keys) run click, type and key together with one window check, one overlay
  update and one verification at the end, with the same approvals for any consequential step.
- Update the agent skill so agents batch routine steps instead of one call per step.

## Overlay and checks (applies throughout)

- Update the action card at most every 150 ms during a batch instead of per step.
- Keep Stop, pause and takeover checks between every step of a batch; they are cheap and must stay.

## Done when

- `benchmark:form` and `benchmark:desktop-actions` meet the targets above on this machine, three runs each.
- `check:live` 87 of 87, full test suite green, 0 failed and 0 unverified calls in the benchmarks.
- A before/after table is added here, and the change log says what got faster and by how much.
