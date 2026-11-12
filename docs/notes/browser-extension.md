# Browser extension bridge (Phase 8)

Status: code and unit tests exist in `packages/browser-extension/`; connected to the MCP server (see the last section). Run once in headless Chrome 150 (see the last section); never in Firefox.

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

## Tested in headless Chrome

Date: 2026-11-12. Chrome: Google Chrome 150.0.7871.128, `--headless=new`, no display, fresh temp HOME and `--user-data-dir`. Run it with `node packages/browser-extension/scripts/chrome-check.mjs` (not part of vitest; exit 0 only when steps 1 to 3 pass).

| Step | Result | Notes |
|---|---|---|
| 1 Manifest loads | PASS | `--load-extension` is ignored by branded Chrome 150, so the script loads the folder with the DevTools command `Extensions.loadUnpacked` (needs `--enable-unsafe-extension-debugging`). Chrome accepted the MV3 manifest. |
| 2 Service worker starts | PASS | A `service_worker` target for `chrome-extension://<id>/background.js` appears. |
| 3 Native host | PASS | Host manifest in the temp HOME (and the profile's `NativeMessagingHosts`), launcher script, real `connectNative`. A `tabs` request on the host socket came back `{ok:true, tabs:[]}` through Chrome and the service worker; an unknown type was refused with `unknown_type`. |
| 4 Host permission | NOT POSSIBLE | `chrome.permissions.request` with a user gesture from the popup page did not resolve in 10 s; `permissions.contains` stayed false. Nothing was faked. |
| 5 Content script refusal | NOT POSSIBLE | Needs the step 4 grant for `chrome.scripting.executeScript`. The `password_field` refusal is therefore still tested only by unit tests with a fake DOM, and the click/type/snapshot path in a real page is untested. |
| 6 `tabs.query` and allow list | PASS | `chrome.tabs.query` saw the local page tab; `chrome.storage.local` kept `allowedHosts`; with the host allowed (storage and `allowed-hosts.json`) the `tabs` reply lists `{tabId, host, title}` only; with storage emptied the reply is `[]` and a snapshot is refused `host_not_allowed`. |

Findings from the run:

- Fixed: a second host process started by Chrome (one per `connectNative` port, or one-shot from `sendNativeMessage`) used to unlink the first host's socket at start and at exit. Now `claimSocket` in `host/native-host.mjs` tries to connect first. If a live host answers, the new host does not unlink and does not listen; it only relays its own Chrome port over stdio. A stale socket (no answer) is removed and replaced. At exit a host removes the socket only if it created it. The check's step 3b confirms the first host's socket survives a one-shot host.
- Known limit (not changed): `sendNativeMessage` with a request gets no reply. The host treats frames from the extension as responses and drops them. Only requests that arrive through the socket are answered, and the protocol stays as it is.
- Fixed: `extension/background.js` now reconnects after `onDisconnect` with a timer backoff of 1 s, 2 s, 4 s, doubling, capped at 60 s; the count restarts once a connection has lasted 2 s. `connect()` does nothing when a port exists. A request that arrives with no port triggers one connect attempt; if that fails, the answer is `extension_disconnected` (when no port exists at all, the native host already fails the client with the same reason). No `chrome.alarms`: a sleeping service worker is still restarted by Chrome only on events, so a reconnect timer is lost if the worker is stopped; the next start calls `connect()` again.
- Fixed: `host/install-host.mjs --apply` writes a launcher `<home>/.agenthost/browser-extension/bin/agenthost-browser-host` (directory and file mode 0700) with `#!/bin/sh` and `exec '<node>' '<native-host.mjs>'`, both single-quoted for sh, and sets the manifest `path` to it. The manifest stays in the browser's `NativeMessagingHosts` folder (mode 0644). Preview is still the default and writes nothing; nothing is written outside the home folder. The launcher fixes the dependence on `node` being on the PATH Chrome gives native hosts. If node moves, run the installer again.

Not tested: the permission prompt, the content script in a real page, a snapshot/click/type on a real site, the popup UI, Windows and macOS, and everything about Firefox (Firefox was not run; the `background.scripts` key and `allowed_extensions` are unchecked).

## Real page and Firefox

Date: 2026-11-12. Chrome 150.0.7871.128 (`--headless=new`), Firefox 155.0.1 (`-headless`, snap build). Both scripts unset DISPLAY, use temp HOME and profile directories, kill only their own processes, and remove the temp directories in a `finally`. Run: `node packages/browser-extension/scripts/page-check.mjs` and `node packages/browser-extension/scripts/firefox-check.mjs` (not part of vitest).

`page-check.mjs` does NOT load the extension. A small `chrome.runtime` shim (injected with `Page.addScriptToEvaluateOnNewDocument`) captures the `onMessage` listener that `content.js` registers, then `content.js` is evaluated in a real page served from `python3 -m http.server` on 127.0.0.1. It proves the refusal logic and the actions run in a real DOM. It does not prove the extension's real permission path.

| Case | Result | Notes |
|---|---|---|
| Plain text field | PASS | type returned `hello`, page value `hello`, a second snapshot read it back, click ok |
| Password field | PASS | snapshot `refused: password_field`, no value (the page held a secret), type and click refused, page value untouched |
| One-time-code field | PASS | `sensitive_autocomplete`, same checks |
| Card field (cc-number) | PASS | `sensitive_autocomplete`, same checks |
| Field named `token` | PASS | `sensitive_name`, same checks |
| Field named `classname` | PASS | `sensitive_name` (matches `ssn`; the documented over-refusal) |
| Plain button click | PASS | the page's onclick ran once |
| Firefox: `webExtension.install` (type `path`) over BiDi | PASS | Reply `{"extension":"agenthost-browser@agenthost.dev"}`; `webExtension.uninstall` of that id then succeeded, so the add-on was installed. Firefox did not error on a manifest with both `background.service_worker` and `background.scripts`. Warnings in Firefox's console were not captured, and whether the background script ran was not checked. |

Notes: the snap Firefox cannot read `/tmp` ("Could not find profile folder"), so `firefox-check.mjs` puts its temp directory under `~/snap/firefox/common/` and removes it after. It does not write `DevToolsActivePort`; the port is read from the line `WebDriver BiDi listening on ws://127.0.0.1:<port>` in the output. Node 20 has no WebSocket, so the script has a minimal client.

Not tested:

- The real permission grant (`optional_host_permissions` prompt) in Chrome or Firefox. No grant was attempted or faked.
- The real `chrome.scripting.executeScript` and `tabs.sendMessage` path from `background.js` (lines 117 and 118). The shim calls the listener directly.
- The extension's content script injected by the browser (isolated world, `chrome.runtime` from the browser).
- Firefox: the background script running, native messaging, `allowed_extensions`, content scripts, the popup.
- A human using the popup, and Windows and macOS.
