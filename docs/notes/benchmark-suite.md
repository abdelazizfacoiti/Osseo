# Benchmark suite (Phase 7)

Public numbers for Osseo: 25 small browser tasks, each measured for success, tool calls, result bytes and seconds. `npm run benchmark:suite` runs it; the same script is a CI gate.

## What it is and is not

- The tasks are scripts that make the tool calls an agent would make. They measure the tool surface (how many calls and bytes a job takes, and whether the page ends up right), not a model's choices. Read the numbers as a regression gate and a public yardstick, not as a claim about any one agent.
- Every task runs in headless Chrome (`--headless=new`) through `browser.open`, on a local HTML page in `benchmarks/suite/tasks/`. There is no display, no nested X server and no external URL. The real screen is never touched: `DISPLAY` is removed from the server's environment.
- Each task gets a fresh server process, a fresh `OSSEO_HOME` in a temp directory, and a fresh Chrome profile. The server runs with `OSSEO_TOOLS_PROFILE=full`, because the tasks call `browser.*` by name.
- This is the browser route only. The pixel routes (desktop clicks and typing in a nested display) stay in `benchmark:form` and `check:live`. A desktop-route suite is a later extension.

## Running it

    npm run build
    node scripts/benchmark-suite.mjs [--tasks id,id] [--runs n] [--out file]

- `--tasks` runs a subset by id. `--runs n` repeats each task n times (each run is a fresh server); the table shows per-task medians and a task passes only if every run passed. `--out` overrides `benchmarks/suite/results/latest.json`.
- `OSSEO_REPO=<dir>` uses the built servers of another tree (fixtures still come from this one).
- Exit code 0 when the gate passes and every task passed, 1 otherwise, 2 when the build or a fixture is missing.

## What is measured

| field | meaning |
|---|---|
| success | the condition below holds on a harness snapshot taken after the driver, and the driver finished without an unexpected error |
| calls | tool calls the driver made (the harness snapshot is not counted) |
| bytes | sum of the byte length of each reply's JSON text |
| seconds | wall clock from the first call to the end of the driver, not including server start |
| refused | the task expects a refusal and it happened |

Two things happen outside the counts: the operator's `osseo confirm <token>` for the two tasks that need a confirmation token, and writing the upload fixture file. The tool calls for those tasks (a dry run, then the call with `confirmationToken`) are counted.

An unverified success is a task whose driver finished without error (an agent would have reported "done") while the condition is false. The gate wants none.

## Gate

Success rate at least 0.9 and unverified successes equal to 0. The script prints the values and `gate result: PASS` or `FAIL`.

## The 25 tasks

| id | what it checks |
|---|---|
| text_fields | two text fields, one fill, save |
| select_value | select by option value |
| select_label | select by visible label |
| checkboxes | two of three ticked |
| radio | one radio chosen |
| multipage | three pages, two form submits |
| upload | `browser.upload` with a dry-run token and `confirmationToken` |
| disabled_button | click on a disabled button is refused (`element_disabled`), page unchanged |
| iframe_field | field and button inside a same-origin iframe |
| table_read | read a table cell from page text, type it into a field |
| search_results | type with Enter, open a result |
| pagination | three pages, select an item on the last |
| inline_confirm | an "are you sure" step on the page, no browser dialog |
| consequential_click | "Place order" needs a preview and a token |
| password_refused | `browser.fill` with a password field is refused (`sensitive_field`) and nothing is typed, including in the other field |
| back_button | link, then `browser.navigate` back |
| validation_fixed | bad email, read the error, fix, save |
| long_form | 30 fields with scrolling, fill the first, middle and last |
| textarea | multi-line text |
| tabs | reveal a hidden panel, fill it |
| wait_for_result | `browser.wait_for` after a delayed update |
| replace_prefilled | replace a prefilled value |
| stale_ref | a ref from before a reload is refused (`stale_ref`), then a fresh ref works |
| unicode_text | accents and CJK characters |
| reload_keeps_state | save to storage, reload, read it back |

Each task's id, goal, fixture, tools, driver and condition are in `benchmarks/suite/tasks/index.mjs`. Fixtures are under 20 KB and use no external URL.

## Output

`benchmarks/suite/results/latest.json` is overwritten on each run. Its header has the Osseo version, tool profile, Chrome version and date. Per task it has the metrics and the first run's tool names with ok/error codes. It holds no page content and no typed text. The results folder should be git-ignored (keep `.gitkeep`).

## Known limits

- Numbers for one Chrome version only; the header records which. Seconds depend on the machine, so compare calls and bytes across machines and seconds only on one.
- A `<select>` wrapped inside its `<label>` gets an accessible name that includes all its options, so the fixtures use `<label for>`. That is a real rough edge in `browser.snapshot`, not a benchmark choice.
- Nothing here exercises desktop (pixel) tools, native file dialogs, Windows, or a real display.
