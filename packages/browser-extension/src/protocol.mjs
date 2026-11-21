// Shared protocol logic for the Osseo browser bridge: Chrome native messaging framing,
// request validation, and the allowed-host check. Pure, no I/O.

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const REQUEST_TYPES = ["snapshot", "click", "type", "select", "navigate", "read", "tabs"];
export const MAX_TAB_TITLE = 80;
export const MAX_TABS = 200;

export const REFUSALS = {
  badFrame: "bad_frame",
  tooLarge: "message_too_large",
  badJson: "bad_json",
  notObject: "not_an_object",
  unknownType: "unknown_type",
  missingId: "missing_id",
  badTabId: "bad_tab_id",
  badHost: "bad_host",
  hostNotAllowed: "host_not_allowed",
  missingField: "missing_field",
  badUrl: "bad_url"
};

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error(REFUSALS.tooLarge);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder. push(chunk) returns the messages completed by that chunk; throws on an oversized frame. */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        this.#buffer = Buffer.alloc(0);
        throw new Error(REFUSALS.tooLarge);
      }
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        throw new Error(REFUSALS.badJson);
      }
      messages.push(parsed);
    }
    return messages;
  }
}

const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A plain lower-case hostname: no scheme, path, port, credentials or spaces. */
export function isPlainHostname(host) {
  return typeof host === "string" && HOST_PATTERN.test(host);
}

/** Exact host or a subdomain of an allowed host. `evil-example.com` does not match `example.com`. */
export function hostAllowed(host, allowed) {
  if (!isPlainHostname(host) || !Array.isArray(allowed)) return false;
  return allowed.some((entry) => typeof entry === "string" && isPlainHostname(entry) && (host === entry || host.endsWith("." + entry)));
}

/** Returns { ok: true, request } or { ok: false, reason }. Does not check the allow list. */
export function validateRequest(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return { ok: false, reason: REFUSALS.notObject };
  if (!REQUEST_TYPES.includes(message.type)) return { ok: false, reason: REFUSALS.unknownType };
  if (!(typeof message.id === "string" && message.id.length > 0 && message.id.length <= 64) && !Number.isSafeInteger(message.id)) return { ok: false, reason: REFUSALS.missingId };
  if (message.type === "tabs") return { ok: true, request: { id: message.id, type: "tabs" } };
  if (!Number.isSafeInteger(message.tabId) || message.tabId < 0) return { ok: false, reason: REFUSALS.badTabId };
  if (!isPlainHostname(message.host)) return { ok: false, reason: REFUSALS.badHost };
  const request = { id: message.id, type: message.type, tabId: message.tabId, host: message.host };
  const needRef = message.type === "click" || message.type === "type" || message.type === "select";
  if (needRef) {
    if (typeof message.ref !== "string" || !/^s\d+-e\d+$/.test(message.ref)) return { ok: false, reason: REFUSALS.missingField };
    request.ref = message.ref;
  }
  if (message.type === "type" || message.type === "select") {
    const key = message.type === "type" ? "text" : "value";
    if (typeof message[key] !== "string" || message[key].length > 10000) return { ok: false, reason: REFUSALS.missingField };
    request[key] = message[key];
  }
  if (message.type === "navigate") {
    let url;
    try { url = new URL(message.url); } catch { return { ok: false, reason: REFUSALS.badUrl }; }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: REFUSALS.badUrl };
    if (url.username || url.password) return { ok: false, reason: REFUSALS.badUrl };
    request.url = url.href;
    request.targetHost = url.hostname.toLowerCase();
  }
  return { ok: true, request };
}

/**
 * The tab list the extension may report: only tabs whose host is allowed, and only { tabId, host, title }.
 * The title is cut to 80 characters. A url, if one is present on the input, is never copied.
 */
export function filterTabsForAllowedHosts(tabs, allowedHosts) {
  if (!Array.isArray(tabs)) return [];
  const out = [];
  for (const tab of tabs) {
    if (out.length >= MAX_TABS) break;
    if (tab === null || typeof tab !== "object") continue;
    if (!Number.isSafeInteger(tab.tabId) || tab.tabId < 0) continue;
    if (!hostAllowed(tab.host, allowedHosts)) continue;
    const title = typeof tab.title === "string" ? Array.from(tab.title).slice(0, MAX_TAB_TITLE).join("") : "";
    out.push({ tabId: tab.tabId, host: tab.host, title });
  }
  return out;
}

/** Validation plus the allow list, for the host and for tests. A navigation target must be allowed too. */
export function checkRequest(message, allowed) {
  const result = validateRequest(message);
  if (!result.ok) return result;
  const { request } = result;
  if (request.type === "tabs") return result;
  if (!hostAllowed(request.host, allowed)) return { ok: false, reason: REFUSALS.hostNotAllowed };
  if (request.type === "navigate" && !hostAllowed(request.targetHost, allowed)) return { ok: false, reason: REFUSALS.hostNotAllowed };
  return result;
}

/** Shape check for what the extension sends back. */
export function validateResponse(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  if (!(typeof message.id === "string" || Number.isSafeInteger(message.id))) return false;
  return typeof message.ok === "boolean";
}
