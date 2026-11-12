# Browser extension bridge (Phase 8)

Status: code and unit tests exist in `packages/browser-extension/`; connected to the MCP server (see the last section). Never run in a real browser.

## Parts

- `extension/` is a Manifest V3 extension for Chrome and Firefox. The person loads it unpacked.
- `host/native-host.mjs` is the native messaging host. The browser starts it; it talks Chrome framing on stdin and stdout, and listens on a private unix socket (`~/.agenthost/run/browser-extension.sock`, mode 0600) for requests from AgentHost.
- `src/protocol.mjs` holds framing, request validation and the allowed-host check. `src/refusals.mjs` holds the field refusal predicate.

## Requests

Types: `snapshot`, `click`, `type`, `select`, `navigate`, `read`. Each names `id`, `tabId` and `host` (a plain hostname). Element refs look like `s<snapshot>-e<index>`, as in the dedicated browser. A snapshot lists role, name, enabled, value for ordinary fields, and a ref.

## Guarantees

- No site is touched unless it is in the allowed list. The popup asks the browser for permission for that one host and stores it in `chrome.storage.local`. The manifest has no `<all_urls>` and no `host_permissions`, only optional http and https patterns that the popup narrows to one host.
- The background script reads the list on every request and also checks that the tab is still on the named host, so a redirect to another site is refused.
- The native host checks the list again from `~/.agenthost/browser-extension/allowed-hosts.json` (read per request; a missing or bad file allows nothing). A navigation target must be allowed too.
- Password fields, `one-time-code`, `cc-*` and `current-password`/`new-password` autocomplete values, and names or ids matching `password|passcode|otp|token|secret|card|cvv|cvc|iban|ssn` are refused before any typing, and their value is never returned. The pattern is broad on purpose: "tokenizer", "classname" and "discard" are refused too.
- The content script never touches cookies or page storage. Page content goes only back through the native host to the requester. Messages over 1 MB are refused.

## Two copies kept equal by tests

Content scripts cannot import modules, so the refusal predicate lives in `src/refusals.mjs` and is copied into `content.js` between `BEGIN refusals` and `END refusals`. `hostAllowed` is copied into `background.js` the same way. Tests compare the copies.

## Install

`node packages/browser-extension/host/install-host.mjs --browser chrome --extension-id <id>` prints what it would write. Add `--apply` to write the host manifest under the user's home. Windows (registry) is not supported yet.

## Not done

- Loading the unpacked extension, the native messaging handshake, and the permission prompt have not been tried in a real browser.
- No `browser.*` route in the MCP server yet, and nothing writes `allowed-hosts.json` from `policy.toml`.
- Firefox needs `background.scripts`; the manifest lists both keys and has not been checked on Firefox.
- No store packaging or signing.

## Connected to the MCP server

The server now has `browser.own_snapshot`, `browser.own_click`, `browser.own_type`, `browser.own_select`, `browser.own_navigate`, `browser.own_read` and `browser.own_tabs` (`packages/mcp-server/src/tools/own-browser.ts`). `browser-extension-client.ts` sends one framed request per call to the native host's socket (`<agent home>/run/browser-extension.sock`, or `AGENTHOST_BROWSER_SOCKET`) and waits up to 15 s for the reply with the same id. The framing is a copy of `src/protocol.mjs`; a test compares the two.

- Each call names `tabId`, `host` (a plain lower-case hostname, else `bad_host`) and the ref or value it needs.
- A host is usable only when the first `site` rule in `policy.toml` that matches it (action `any`, any app) says `allow`. No rule, `ask` or `never` gives `host_not_allowed` before anything is sent. A suffix rule matches the host and its subdomains, never `evil-example.com`. A navigation target must pass the same check.
- Click, select, type and navigate also go through the file rules for `click`, `type` and `navigate` on that host: `never` refuses (`policy_never`), `ask` needs a confirmation token. Snapshot and read are classified as `inspect` and go through the same safety evaluation as the dedicated browser.
- Results are `{ ok, reason?, ... }`. On success the extension's fields are returned unchanged. On failure the reason is the extension's (`password_field`, `sensitive_autocomplete`, `sensitive_name`, `ref_stale`, `host_not_allowed`, `timeout`, `extension_not_running`, ...); a reason that is not short snake_case is replaced by `extension_error`. No field value is ever in an error.
- Typed text and select values are never in the audit summary, only their length.
- The server writes `<agent home>/browser-extension/allowed-hosts.json` (0600, atomic, only when the content changed) from the `site` allow rules, at the start of every `browser.own_*` call when `policy.toml` has a new mtime or size. It is not written at server start, only on the first call.
- `browser.own_tabs` sends a `tabs` request (no tabId or host). The extension answers with only the tabs whose host is on its allow list, as `{ tabId, host, title }` (hostname only, title cut to 80 characters, never a url or page content). The native host filters the reply again with `filterTabsForAllowedHosts` against `allowed-hosts.json`, and the tool filters a third time against the `site` allow rules in `policy.toml`. Result: `{ ok: true, tabs }` or a failure with the extension's reason (`extension_not_running`, `timeout`, ...). At most 200 tabs.

Not tested: a real Chrome, the real native host process, and the permission prompt. Tests use a fake unix socket server.
