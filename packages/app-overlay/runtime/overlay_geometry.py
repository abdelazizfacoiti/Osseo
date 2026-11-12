"""Pure geometry helpers for the GTK3 overlay renderer."""


def clamp(value, low, high):
    return min(max(value, low), high)


def beside_position(area, width, height, bounds=None, point=None, margin=24, gap=12):
    """Place a label next to its target: right, left, below, then above; the first that fits wins."""
    area_x, area_y, area_width, area_height = area
    width = max(1, int(width))
    height = max(1, int(height))
    if isinstance(bounds, dict):
        try:
            box_x, box_y = float(bounds.get("x", 0)), float(bounds.get("y", 0))
            box_w, box_h = float(bounds.get("width", 1)), float(bounds.get("height", 1))
        except (TypeError, ValueError):
            box_x, box_y, box_w, box_h = area_x, area_y, 1.0, 1.0
    else:
        box_x, box_y = float(point.get("x", 0)), float(point.get("y", 0))
        box_w, box_h = 0.0, 0.0
    candidates = [
        (box_x + box_w + gap, box_y),
        (box_x - width - gap, box_y),
        (box_x, box_y + box_h + gap),
        (box_x, box_y - height - gap),
    ]
    for x, y in candidates:
        if x >= area_x and y >= area_y and x + width <= area_x + area_width and y + height <= area_y + area_height:
            return int(x), int(y)
    x = clamp(box_x + box_w + gap, area_x + margin, area_x + area_width - width - margin)
    y = clamp(box_y, area_y + margin, area_y + area_height - height - margin)
    return int(x), int(y)


def card_position(area, width, height, placement="top_right", bounds=None, point=None, user_position=None, margin=24, attach=None):
    area_x, area_y, area_width, area_height = area
    width = max(1, int(width))
    height = max(1, int(height))
    margin = max(0, int(margin))
    if attach == "beside" and user_position is None and (isinstance(bounds, dict) or isinstance(point, dict)):
        return beside_position(area, width, height, bounds=bounds if isinstance(bounds, dict) else None, point=point if isinstance(point, dict) else None, margin=margin)

    if isinstance(user_position, (tuple, list)) and not isinstance(bounds, dict) and not isinstance(point, dict):
        x, y = float(user_position[0]), float(user_position[1])
    elif isinstance(bounds, dict):
        try:
            x = float(bounds.get("x", 0)) + float(bounds.get("width", 1)) + 12
            y = float(bounds.get("y", 0))
        except (TypeError, ValueError):
            x, y = area_x + margin, area_y + margin
    elif isinstance(point, dict):
        try:
            x = float(point.get("x", 0)) + 20
            y = float(point.get("y", 0)) + 20
        except (TypeError, ValueError):
            x, y = area_x + margin, area_y + margin
    else:
        if placement in {"top_center", "bottom_center"}:
            x = area_x + (area_width - width) / 2
        elif placement in {"top_left", "bottom_left"}:
            x = area_x + margin
        else:
            x = area_x + area_width - width - margin
        y = area_y + area_height - height - margin if placement in {"bottom_left", "bottom_center", "bottom_right"} else area_y + margin

    avoid = None
    if isinstance(bounds, dict):
        try:
            avoid = (
                float(bounds.get("x", 0)) - 28,
                float(bounds.get("y", 0)) - 28,
                float(bounds.get("width", 1)) + 56,
                float(bounds.get("height", 1)) + 56,
            )
        except (TypeError, ValueError):
            avoid = None
    elif isinstance(point, dict):
        try:
            avoid = (float(point.get("x", 0)) - 52, float(point.get("y", 0)) - 52, 104, 104)
        except (TypeError, ValueError):
            avoid = None

    if avoid is not None:
        avoid_x, avoid_y, avoid_width, avoid_height = avoid

        def overlaps(candidate_x, candidate_y):
            return candidate_x < avoid_x + avoid_width and candidate_x + width > avoid_x and candidate_y < avoid_y + avoid_height and candidate_y + height > avoid_y

        corners = [
            (area_x + margin, area_y + margin),
            (area_x + area_width - width - margin, area_y + margin),
            (area_x + margin, area_y + area_height - height - margin),
            (area_x + area_width - width - margin, area_y + area_height - height - margin),
        ]
        if placement in {"top_left", "bottom_left"}:
            corners = [corners[0], corners[2], corners[1], corners[3]]
        elif placement in {"top_right", "bottom_right"}:
            corners = [corners[1], corners[3], corners[0], corners[2]]
        elif placement == "bottom_center":
            corners = [corners[2], corners[3], corners[0], corners[1]]
        for candidate_x, candidate_y in [(x, y), *corners]:
            if not overlaps(candidate_x, candidate_y):
                x, y = candidate_x, candidate_y
                break

    x = clamp(x, area_x + margin, area_x + area_width - width - margin)
    y = clamp(y, area_y + margin, area_y + area_height - height - margin)
    return int(x), int(y)


def ring_placement(monitors, bounds, pad=28):
    pad = max(0, int(pad))
    width = max(64, int(bounds[2] + 2 * pad))
    height = max(64, int(bounds[3] + 2 * pad))
    monitor = monitors[0] if monitors else (0, 0, 1920, 1080, 1)
    center_x = bounds[0] + bounds[2] / 2
    center_y = bounds[1] + bounds[3] / 2
    for candidate in monitors:
        if candidate[0] <= center_x < candidate[0] + candidate[2] and candidate[1] <= center_y < candidate[1] + candidate[3]:
            monitor = candidate
            break
    monitor_x, monitor_y, monitor_width, monitor_height = monitor[:4]
    x = clamp(int(bounds[0] - pad), int(monitor_x), int(monitor_x + monitor_width - width))
    y = clamp(int(bounds[1] - pad), int(monitor_y), int(monitor_y + monitor_height - height))
    return x, y, width, height


def dock_layout(area_height, timeline_height, bottom_heights, margin=24, bottom_share=0.45, min_timeline=96, min_bottom=64):
    """Split the dock so the timeline never reaches the bottom cards.

    Bottom cards (task card with Pause/Stop) are placed first and stack upward
    from the dock floor. They may use `bottom_share` of the dock, or more when
    the timeline does not need the room. The timeline takes what remains. A
    `timeline_height` of 0 means there is no timeline. Returned `y` values are
    relative to the top of the dock area.
    """
    margin = max(0, int(margin))
    usable = max(1, int(area_height) - 2 * margin)
    timeline_wanted = max(0, int(timeline_height))
    has_timeline = timeline_wanted > 0
    if has_timeline:
        spare = usable - min(timeline_wanted, usable) - margin
        budget = min(max(int(area_height * bottom_share), spare), usable - margin - min_timeline)
    else:
        budget = usable

    bottom = []
    floor = int(area_height) - margin
    remaining = budget
    for index, wanted in enumerate(bottom_heights):
        later = len(bottom_heights) - index - 1
        available = remaining - later * (min_bottom + margin)
        height = max(min_bottom, min(int(wanted), available))
        floor -= height
        bottom.append({"y": max(margin, floor), "height": height})
        floor -= margin
        remaining -= height + margin

    timeline = 0
    if has_timeline:
        used = sum(card["height"] for card in bottom) + margin * max(0, len(bottom) - 1)
        room = usable - used - (margin if bottom else 0)
        timeline = max(min_timeline, min(timeline_wanted, room))
    return {"timeline": timeline, "bottom": bottom}


RAIL_WIDTH = 48
RAIL_COLLAPSE_MS = 800


def rail_rects(monitor, side="right", dock_width=240, rail_width=RAIL_WIDTH):
    """Rectangles of the opt-in rail layout on one monitor `(x, y, width, height)`.

    `collapsed` is the always-visible strip on the chosen edge; it is also the
    only part that reserves work area (`strut` pixels from that edge). `expanded`
    is the panel that holds the dock content; it sits beside the strip, toward
    the middle of the screen, so the two never overlap.
    """
    x, y, width, height = (int(value) for value in monitor[:4])
    rail = max(1, min(int(rail_width), width))
    panel = max(1, min(int(dock_width), width - rail))
    if side == "left":
        collapsed_x, expanded_x = x, x + rail
    else:
        collapsed_x, expanded_x = x + width - rail, x + width - rail - panel
    return {
        "collapsed": (collapsed_x, y, rail, height),
        "expanded": (expanded_x, y, panel, height),
        "strut": rail,
    }


def rail_expanded(hovering, since_left_ms, attention=False, error=False, collapse_ms=RAIL_COLLAPSE_MS):
    """Decide whether the rail shows the dock content.

    Expanded while the pointer is over it, while an approval wait or an error is
    present, and for `collapse_ms` after the pointer left (`since_left_ms` is
    None when it never left or is still inside).
    """
    if hovering or attention or error:
        return True
    return since_left_ms is not None and since_left_ms < collapse_ms


def rail_words(text, count=3, width=7):
    """The current action in at most `count` words, each cut to `width` characters; "Idle" when empty."""
    words = [word for word in str(text or "").split() if word]
    if not words:
        return "Idle"
    return " ".join(word if len(word) <= width else word[: width - 1] + "." for word in words[:count])


def rail_status(components):
    """Return `(status, action, attention, error)` from a timeline card's components.

    `status` is one of running, paused, stopped, waiting, idle, read from the
    same status badge and entries the dock timeline shows.
    """
    badge = ""
    entries = []
    for component in components or []:
        if not isinstance(component, dict):
            continue
        if component.get("type") == "status_badge":
            badge = str(component.get("text", ""))
        elif component.get("type") == "timeline" and isinstance(component.get("entries"), list):
            entries = [entry for entry in component["entries"] if isinstance(entry, dict)]
    status = {"Waiting for you": "waiting", "Stopped": "stopped", "Paused": "paused", "Working": "running"}.get(badge, "idle")
    action = "Idle"
    for entry in entries:
        if entry.get("state") == "running":
            action = rail_words(entry.get("label"))
            break
    failed = bool(entries) and entries[0].get("state") in {"failed", "halted"}
    return status, action, status == "waiting", status == "stopped" or failed
