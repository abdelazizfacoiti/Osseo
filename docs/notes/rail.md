# Rail layout (opt-in)

`overlay.layout: "rail"` replaces the dock with a 48 px strip on the edge chosen by `overlay.dockSide`. `dock` stays the default.

- Collapsed: a status dot (idle, running, paused, stopped, waiting), the current action in at most three words ("Idle" when none), and Stop. Status and action come from the dock timeline card (its status badge and first running entry).
- Reserved space: 48 px through the dock's strut (`dockReserveSpace`), nothing else.
- Expanded: the usual dock content (timeline above bottom cards, `dock_layout`) in a panel of the normal dock width (`dockWidthPercent`) beside the strip. Expands when the pointer enters the strip (or the panel), stays expanded while an approval wait, a stop or a failed/halted entry shows, and collapses 800 ms after the pointer leaves.
- Stop goes through `on_footer_click` with the card that allows `emergency_stop_requested`: real pointer press only, XTEST ignored. No new event type, no new trusted event. Stop is disabled when no live card allows it.
- Pure code: `rail_rects`, `rail_expanded`, `rail_status`, `rail_words` in `packages/app-overlay/runtime/overlay_geometry.py`.
- Check: `python3 packages/app-overlay/runtime/rail_selftest.py` (starts Xephyr on a free display; exit 77 = skipped).
- Needs server support: `packages/mcp-server/src/server.ts` creates the timeline and the dock-style action card only when `layout === "dock"`; it must accept `"rail"` too, or the rail shows only Idle.
