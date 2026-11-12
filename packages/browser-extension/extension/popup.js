// Popup: allow or forget sites. It asks only for the current host, never broader permissions.
const hostEl = document.getElementById("host");
const allowEl = document.getElementById("allow");
const statusEl = document.getElementById("status");
let currentHost = "";

const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

async function getAllowed() {
  const stored = await chrome.storage.local.get("allowedHosts");
  return Array.isArray(stored.allowedHosts) ? stored.allowedHosts : [];
}

function origins(host) {
  return ["https://" + host + "/*", "http://" + host + "/*"];
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab.url);
    if (url.protocol === "http:" || url.protocol === "https:") currentHost = url.hostname.toLowerCase();
  } catch { currentHost = ""; }
  if (!HOST_PATTERN.test(currentHost)) {
    hostEl.textContent = "No usable site on this tab";
    return;
  }
  hostEl.textContent = currentHost;
  allowEl.disabled = false;
  allowEl.checked = (await getAllowed()).includes(currentHost);
}

allowEl.addEventListener("change", async () => {
  const allowed = await getAllowed();
  if (allowEl.checked) {
    // Must run in this click handler: the browser shows its own permission prompt for this host only.
    const granted = await chrome.permissions.request({ origins: origins(currentHost) });
    if (!granted) { allowEl.checked = false; statusEl.textContent = "Permission not granted."; return; }
    if (!allowed.includes(currentHost)) allowed.push(currentHost);
    await chrome.storage.local.set({ allowedHosts: allowed });
    statusEl.textContent = "Allowed.";
  } else {
    await chrome.storage.local.set({ allowedHosts: allowed.filter((h) => h !== currentHost) });
    await chrome.permissions.remove({ origins: origins(currentHost) });
    statusEl.textContent = "Removed.";
  }
});

document.getElementById("forget").addEventListener("click", async () => {
  const allowed = await getAllowed();
  await chrome.storage.local.set({ allowedHosts: [] });
  for (const host of allowed) await chrome.permissions.remove({ origins: origins(host) });
  allowEl.checked = false;
  statusEl.textContent = "All sites forgotten.";
});

void init();
