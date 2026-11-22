# Configuration

Settings live in `~/.config/osseo/config.json` (`osseo config path` shows the file in use, `osseo config validate`
checks it). Everything is optional; an empty file, or none, gives the defaults below. Rules about what needs approval
are not here: they live in [`policy.toml`](safety.md#your-rules-osseopolicytoml).

```json
{
  "schemaVersion": 1,
  "tools": { "profile": "desktop" },
  "overlay": { "frame": "always" },
  "approvals": { "chat": true }
}
```

## Common settings

| Key | Default | What it does |
|---|---|---|
| `tools.profile` | `"desktop"` | `desktop` lists the 14 numbered tools; `full` lists all of them. Hidden tools stay callable. |
| `approvals.chat` | `true` | Ask for approval in the agent client's chat (cards and the CLI stay as fallbacks). |
| `attention.sound` | `true` | Soft chime while an approval or hand-off waits. |
| `attention.soundIntervalMs` | `8000` | Gap between chimes. |
| `execution.placement` | `"foreground"` | `background` runs the agent on a separate virtual display (see `osseo viewer`). |
| `execution.yieldToUser` | `true` | The agent yields when you start using the mouse or keyboard. |
| `execution.maxActionsPerTask` | `500` | Upper bound on actions in one task. |
| `replay.onTaskFinish` | `false` | Build a replay page automatically when a task ends. |
| `notifications.pushUrl` | none | An https URL (for example a private ntfy topic) that gets a generic "Osseo is waiting for you" message. It cannot approve anything. |
| `blockedApps` | none | Extra app names the agent must never drive. |
| `autoInstallDependencies` | `true` | On first start, offer one password-prompted install of missing desktop packages. Never silent. |

## On-screen overlay

| Key | Default | What it does |
|---|---|---|
| `overlay.mode` | `"always"` | When cards show: `always`, `on_change` (state-changing actions only) or `off`. |
| `overlay.layout` | `"dock"` | `dock` (side panel), `rail` (a thin strip that expands) or `ambient` (floating cards). |
| `overlay.dockSide` | `"right"` | Which edge the panel uses. |
| `overlay.dockWidthPercent` | `18` | Panel width (10 to 40). |
| `overlay.dockReserveSpace` | `true` | Reserve the panel's strip so windows are not covered. |
| `overlay.timeline` | `true` | The action history inside the panel. |
| `overlay.frame` | off in dock layout | `true`: an edge frame around actions. `"always"`: a quiet gray frame whenever Osseo runs, coloured by state. |
| `overlay.frameIdleMs` | `120000` | With `"always"`, hide the gray frame after this long without an action (`0` keeps it). |
| `overlay.targetRing` | off in dock layout | A ring around the spot about to be clicked. |
| `overlay.reducedMotion` | `false` | No pulsing or motion. |
| `overlay.windows` | `false` | Turn on the Windows cards (Windows only). |

## Environment variables

| Variable | What it does |
|---|---|
| `OSSEO_HOME` | Data folder (default `~/.osseo`). |
| `OSSEO_CONFIG` | Config file to read. |
| `OSSEO_TOOLS_PROFILE` | `desktop` or `full`, overrides `tools.profile`. |
| `OSSEO_HOST=0` | This session runs its own server instead of sharing the per-user host. |
| `OSSEO_ATTENTION_SOUND=0` | No chime. |
| `OSSEO_WAYLAND_PORTAL=1` | Native Wayland through the desktop portal (experimental, see [platforms](platforms.md)). |
| `OSSEO_WINDOWS_OVERLAY=1` | The Windows cards (same as `overlay.windows`). |
| `OSSEO_TRACE=1` | Timestamped, redacted traces of each call's phases under `~/.osseo/logs/traces/`. |

Variables from before the rename (`AGENTHOST_*`) are still read when the `OSSEO_*` one is not set.
