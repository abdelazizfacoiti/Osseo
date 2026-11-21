# Task reports: shareable run transcripts

`osseo task export` renders a task's redacted event log — the same
bounded summaries `task watch` shows — to a self-contained file you can
post in issues, PRs, and chat:

```bash
osseo task export <task-id> --format md --out ./run-report.md
osseo task export <task-id> --format html --out ./run-report.html
```

- Markdown: goal, status/phase table, and a time/kind/summary timeline.
- HTML: same content as a single styled file, no JavaScript, no external
  assets — safe to attach anywhere.
- Only redacted summaries are included: no secrets, page content,
  screenshots, or absolute private paths.
