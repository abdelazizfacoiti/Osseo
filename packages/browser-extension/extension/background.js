// AgentHost background script. Talks to the native host and forwards requests to the content script.
// The allowed-host list is read from storage on every request, so popup changes apply at once.

const HOST_NAME = "dev.agenthost.browser";
const REQUEST_TYPES = ["snapshot", "click", "type", "select", "navigate", "read", "tabs"];

// BEGIN hostAllowed
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
function isPlainHostname(host) {
  return typeof host === "string" && HOST_PATTERN.test(host);
}
function hostAllowed(host, allowed) {
  if (!isPlainHostname(host) || !Array.isArray(allowed)) return false;
  return allowed.some((entry) => typeof entry === "string" && isPlainHostname(entry) && (host === entry || host.endsWith("." + entry)));
}
// END hostAllowed

let port = null;

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    port = null;
    return;
  }
  port.onMessage.addListener((message) => { void handle(message); });
  port.onDisconnect.addListener(() => { port = null; });
}

function reply(id, body) {
  if (port) port.postMessage({ id, ...body });
}

async function allowedHosts() {
  const stored = await chrome.storage.local.get("allowedHosts");
  return Array.isArray(stored.allowedHosts) ? stored.allowedHosts : [];
}

// Tabs on allowed hosts only, as { tabId, host, title }. Never a url, page content, cookies or storage.
async function listTabs(id) {
  const allowed = await allowedHosts();
  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch { return reply(id, { ok: false, reason: "tabs_unavailable" }); }
  const out = [];
  for (const tab of tabs) {
    if (out.length >= 200) break;
    if (!Number.isSafeInteger(tab.id) || tab.id < 0) continue;
    let host = "";
    try { host = new URL(tab.url || "").hostname.toLowerCase(); } catch { continue; }
    if (!hostAllowed(host, allowed)) continue;
    out.push({ tabId: tab.id, host, title: Array.from(typeof tab.title === "string" ? tab.title : "").slice(0, 80).join("") });
  }
  reply(id, { ok: true, tabs: out });
}

async function handle(message) {
  const id = message && message.id;
  if (!message || !REQUEST_TYPES.includes(message.type)) return reply(id, { ok: false, reason: "unknown_type" });
  if (message.type === "tabs") return listTabs(id);
  if (!Number.isSafeInteger(message.tabId)) return reply(id, { ok: false, reason: "bad_tab_id" });
  if (!isPlainHostname(message.host)) return reply(id, { ok: false, reason: "bad_host" });
  const allowed = await allowedHosts();
  if (!hostAllowed(message.host, allowed)) return reply(id, { ok: false, reason: "host_not_allowed" });
  let tab;
  try { tab = await chrome.tabs.get(message.tabId); } catch { return reply(id, { ok: false, reason: "tab_not_found" }); }
  let tabHost = "";
  try { tabHost = new URL(tab.url || "").hostname.toLowerCase(); } catch { tabHost = ""; }
  // The tab must still be on the host the request named, and that host must be allowed now.
  if (tabHost !== message.host || !hostAllowed(tabHost, allowed)) return reply(id, { ok: false, reason: "host_not_allowed" });

  if (message.type === "navigate") {
    let target;
    try { target = new URL(message.url); } catch { return reply(id, { ok: false, reason: "bad_url" }); }
    if (!["http:", "https:"].includes(target.protocol) || !hostAllowed(target.hostname.toLowerCase(), allowed)) return reply(id, { ok: false, reason: "host_not_allowed" });
    await chrome.tabs.update(message.tabId, { url: target.href });
    return reply(id, { ok: true });
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: message.tabId }, files: ["content.js"] });
    const result = await chrome.tabs.sendMessage(message.tabId, { agenthost: true, ...message });
    reply(id, result || { ok: false, reason: "no_response" });
  } catch (error) {
    reply(id, { ok: false, reason: "page_unavailable" });
  }
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
