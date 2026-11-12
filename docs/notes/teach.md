# Teach mode

`guide.show` with `waitForClick: true` is Teach mode. Without it the guide is unchanged (a box and a tooltip per step, no buttons).

## What the person sees

- Every step has its highlight box. One interactive card sits beside the current step's box: "Step n of m", the step text, Back (not on step 1) and Next (Done on the last step).
- The tooltips are not drawn in Teach mode; the card carries the text. If the card cannot be drawn, the guide falls back to tooltips and the plain wait.
- Back and Next/Done are pointer-only like Stop: the renderer ignores keyboard or accessibility activation, XTEST (synthetic) devices, and any press within 1 s of an agent input (`run/input-active`).

## The loop

- Next: next step. The old card goes, the new step's box is redrawn and its card is shown.
- Back: previous step, same redraw.
- A press inside a box (as before, `waitForPointerPress`): moves on to the step after the one pressed. A press in the last box ends the call with `finished: true`; a one-step guide therefore ends at the first box press.
- Done (Next on the last step): clears everything; the result has `clicked: { index, via: "done" }` and `finished: true`.
- guide.clear ends the wait (`cleared: true`). Stop removes the marks (`stopped: true`). Timeout leaves the marks (`waitTimedOut`).
- Events are read with `pollEvents(cardId)` for the current card only.
- If the pointer watcher is unavailable, the card buttons still work.

## Events

Done is the `next` event on the last step. `done` is not in core's `OverlayEventName` or its policy check, so it was not added. In the renderer `next` and `back` are in `EVENTS` already; they are now in `CONTROL_EVENTS` (pointer release, no recent agent input, no XTEST source) and not in `TRUST_EVENTS` (no physical-device proof).

## Tests

`guide-tools.test.ts` (fake overlay), `teach.test.ts` with `runtime/teach_selftest.py` (own Xephyr on a free display, never `:0`; a synthetic press on Next is ignored). A real hardware press is not tested.
