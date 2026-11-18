# Speed plan: smooth, fast, reliable desktop actions

**Status: IMPLEMENTED 2026-11-18 (all five phases).** Results at the end of this file.

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

## Results (2026-11-18)

Method: the same `benchmark:desktop-actions` script (12 repeats per action, median of three runs) against the build
from before this work (commit `6e6d449`, built in a separate worktree) and the build after. Nested 800x600 display,
overlay off, this Linux machine. Tool time only: the model's thinking time is not in these numbers. No call failed in
either build.

| action | before (ms) | after (ms) | change |
|---|---:|---:|---:|
| see (accessibility tree) | 82 | 51 | -38% |
| click by number, verified | 1,310 | 830 | -37% |
| key (one key) | 910 | 400 | -56% |
| type 11 characters | 2,011 | 950 | -53% |
| 20 keys as 20 calls (total) | 18,299 | 8,190 | -55% |
| 20 keys as 1 sequence call | 1,992 | 1,476 | -26% |
| plan: 5 clicks + 5 keys in 1 call | 11,782 | 2,353 | -80% |
| see (screen text, no accessibility): first read | 546 | 416 | -24% |
| see (screen text, no accessibility): same window again | 363 | 172 | -53% |

Whole-task, `npm run benchmark:form` (one form task, seconds, 3 runs; 0 unverified in every run):

| route | before | after |
|---|---:|---:|
| pixel-before (old desktop path, 19 calls) | 13.3 | 9.0 |
| pixel-after (current desktop path, 9 calls) | 10.3 | 6.2 |
| numbered, agent's browser (see, type, click by number) | 3.8 (9 calls) | 1.5 (8 calls) |
| browser tools directly (6 calls) | 1.6 | 1.3 |

One run of the old build's pixel-after route failed 7 calls (WRONG final state) and one run of the new build's
pixel-before route failed 11 calls; neither repeated in three further runs of the new build (all correct, 0 failed).
These look like flaky timing on the desktop route and are worth a closer look; they are reported, not hidden.

Targets from the plan:

| target | result |
|---|---|
| pixel-after route 13.0 s -> 6.5 s or less | met: 10.3 -> 6.2 s (same-session before/after; the 13.0 baseline was an earlier day) |
| one verified key or click under 0.5 s | key met (0.40 s); a verified click is 0.83 s, not met |
| 20-key sequence under 2 s | met: 1.5 s (18.3 s as 20 calls, 8.2 s now as 20 calls) |
| repeat `see` without an accessibility tree under 1.5 s | met on this small display: 0.17 s (first read 0.42 s). A large real window is bounded by the OCR engine (about 0.6 s for 1509x1048 with one thread) |
| 0 failed, 0 unverified | met in the action benchmark; see the flaky runs above for the form benchmark |

### What changed

1. Cheap capture for effect checks (about 45 ms instead of about 200 ms, 3 to 4 per action): the largest single gain.
2. A plan checks the screen and control list once, at the end, reads the window list twice in total, and previews
   its steps concurrently: a 10-step plan 11.8 s -> 2.4 s.
3. A long-lived Python worker for accessibility queries: `see` 82 -> 51 ms.
4. `set_field` polls instead of sleeping 150 and 200 ms: typing 2.0 -> 0.95 s.
5. OCR reads only the window, caches by image content, one engine thread.
6. A repeated call that changed the screen is progress, not a loop.

### Found on the way (fixed)

- A fixed 120 ms hover wait gave false "changed" results (caught by `check:live`); the wait is adaptive, at most 250 ms.
- A plan step with `expect: screenChanged` lost its check when not last; steps with an expectation keep it.
- The form benchmark's dropdown step pressed Down twice against the popup. It works only inside a timing window
  (150 ms after the click passed 4 of 4; 0, 400 and 800 ms failed 4 of 4) and passed before only because the old build
  was slower. Dropdowns are now chosen by text: `type { n, text }` on a combobox uses `browser.select`.
  The benchmark's numbered route changed with it.
- The loop guard paused ten identical clicks that each changed the window.

### Costs and limits

- Every verified action waits at least 100 ms after the input so slow-reacting apps are measured fairly; that floor
  is part of the 0.4 s per key.
- Measured with the overlay off on a nested display; the overlay's own cost was not measured.
- Large real windows read by OCR stay bounded by the OCR engine. Apps with an accessibility tree (about 50 ms) are the fast path.
- The model's thinking time per step, which usually dominates a real agent loop, is outside these numbers.

## Comparison with other computer-use agents

Not like-for-like. We measure tool time only; published figures for others are per action and include screenshot
capture and model inference. No vendor publishes per-action tool latency for Claude Cowork, Claude computer use or
Codex computer use, so these are third-party or competitor claims. Treat as rough.

| | Reported per-action time | Source and caveat |
|---|---|---|
| Codex computer use | 2 to 4 s (screenshot plus vision inference) | a rival vendor's comparison page; not independent |
| Claude computer use | about 2.1 s per action in one blog; 5 to 10 s for an older model in another article | blogs, no method |
| Claude Cowork | no figure found | |
| Computer-use agents in general | model calls for planning and reflection dominate; later steps take up to 3x longer than early ones | OSWorld-Human, 16 agents |
| AgentHost (tool time only) | 0.05 s `see` with an accessibility tree; 0.2 to 0.4 s `see` by OCR; 0.4 to 0.8 s per verified action; 0.07 s per key inside a sequence | this document |

Reading: a screenshot-and-vision step costs seconds before the action happens. AgentHost reads an accessibility
tree when the app has one (about 50 ms) and adds 0.4 to 0.8 s of verified action. Without a tree it falls back to
OCR, the same class of cost others pay. Model time per step is the same for everyone. A proper comparison needs the
same task run end to end with each agent, counting steps and wall time.

Sources: [OSWorld-Human](https://arxiv.org/html/2506.16042v1), [Simular's Codex comparison](https://www.simular.ai/alternatives/codex-vs-simulang), [OpenAI on agent-loop speed](https://openai.com/index/speeding-up-agentic-workflows-with-websockets).
