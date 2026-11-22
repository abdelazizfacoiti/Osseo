# How it works

```text
your agent (Claude Code, Codex, Cursor, ...)
   │  MCP tool calls over stdio
   ▼
Osseo server ── safety: schema, Stop/pause, preview, approval, audit
   │
   ├── the agent's own browser (DevTools protocol)
   ├── accessibility tree (AT-SPI)
   ├── screen text (OCR) and pictures
   └── keyboard and mouse (X11)
   ▼
any app on your screen, with the side panel and edge frame showing every step
```

## See, then act by number

`see` lists what can be acted on in a window, one numbered line per element:

```text
[1] button "Save"
[2] entry "Name" = "Ada"
[3] link "Pricing"
```

`click { n: 1 }`, `type { n: 2, text: "Grace" }`, `scroll`, `drag` and `key` then act on those numbers. A number
belongs to the view that issued it; after anything changes, call `see` again. Numbers in a window that has moved or
resized are refused rather than guessed.

`see` reads the window the best way it can, in this order:

1. **The agent's own browser page**: exact DOM elements.
2. **The accessibility tree**: real buttons, fields and menus, with names and states.
3. **Screen text (OCR)**: words on the screen, for apps that expose no structure (for example Blender).
4. **Nothing**: then only the picture is left.

`see` can attach a picture of the window (`picture: "plain"` or `"marked"`, which draws the numbers on it). When an
agent has to click a spot that has no number, `click { x, y }` takes the position **in that picture**; Osseo converts
it to the screen (`pictureMap` in the result says how). `space: "screen"` passes raw screen pixels instead.

## Every action is checked

A click, key press or typed text is followed by a check of what it did:

- **Typed text is read back** from the field, so "typed" means the field holds the text.
- **The window is compared** before and after (`effect.screenChanged`), and the accessibility tree is compared too, so
  the result says in words what changed ("a dialog opened", "Save is now enabled").
- A click that changed nothing says so ("the click may have missed"), instead of reporting success.

`steps` runs up to 20 calls as one plan and checks once at the end, and `key { sequence }` sends a series of keys in
one call: routine work does not pay for a check after every key.

## Choosing the route

For any task Osseo prefers, in order: the agent's own browser for web pages, the accessibility tree, the keyboard,
and only then screen text and pixel positions. Web tasks open in a separate browser profile under
`~/.osseo/browser/profiles/agent/`, never your own profile; `open { url, in: "my-browser" }` opens your default
browser instead.

## What you see

- **The side panel** on the right edge keeps a timeline of every action, with Pause and Stop always visible.
  It reserves its own strip of the screen, so windows are not covered.
- **The edge frame** shows the state at a glance: blue while an action runs, green when done, amber while waiting for
  you, red on an error. With `"frame": "always"` a quiet gray frame shows that Osseo is on; it fades after two minutes
  without an action.
- **Cards** show the current action and the approval requests. Only a real mouse press counts on them, so the agent
  cannot press Approve, Resume or Stop for you.
- When it needs you, a soft chime repeats and your terminal is raised.

Several agent sessions share one small local host and therefore one panel and one frame.

## Hand-off and guide mode

- `ask` hands a step to you (a login, a code, a captcha, a payment): a card says what to do, and the agent waits
  until you press Continue. Screen reading stops meanwhile.
- `guide.show` draws boxes and labels where you should click, for apps the agent must not drive. It never clicks.

## Working in the background

With `"execution": { "placement": "background" }` the agent works on a separate virtual display instead of your
screen; `osseo viewer start` shows it in a small window with Pause, Resume and Stop.

## After the run

- `osseo replay build --last` makes one HTML page of the session from the audit log (no screenshots, no typed text).
- `osseo journal save <name> --apply` turns the steps the agent took into a saved workflow that
  `osseo workflow run <name>` repeats, and `osseo schedule add` runs on a timer.
