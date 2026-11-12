# Browser extension bridge (Phase 8)

Status: code and unit tests exist in `packages/browser-extension/`. Not connected to the MCP server. Never run in a real browser.

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
