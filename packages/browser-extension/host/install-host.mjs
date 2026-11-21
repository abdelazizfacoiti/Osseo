#!/usr/bin/env node
// Writes the native messaging host manifest for the current user. Prints what it would do unless --apply.
// Usage: node install-host.mjs --browser chrome|chromium|firefox --extension-id <id> [--apply]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launcherScript } from "./launcher.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const browser = option("--browser", "chrome");
const extensionId = option("--extension-id", "");

const home = os.homedir();
const linux = {
  chrome: path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
  chromium: path.join(home, ".config", "chromium", "NativeMessagingHosts"),
  firefox: path.join(home, ".mozilla", "native-messaging-hosts")
};
const mac = {
  chrome: path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
  chromium: path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
  firefox: path.join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
};
if (process.platform === "win32") { console.error("Windows needs a registry entry; not supported by this script yet."); process.exit(2); }
const dirs = process.platform === "darwin" ? mac : linux;
const dir = dirs[browser];
if (!dir) { console.error("Unknown browser: " + browser); process.exit(2); }
if (browser !== "firefox" && !/^[a-p]{32}$/.test(extensionId)) { console.error("Chrome and Chromium need --extension-id (32 letters a-p, shown on chrome://extensions)."); process.exit(2); }

const hostScript = path.join(here, "native-host.mjs");
const binDir = path.join(home, ".osseo", "browser-extension", "bin");
const launcherPath = path.join(binDir, "osseo-browser-host");
const hostPath = launcherPath;
const template = JSON.parse(fs.readFileSync(path.join(here, "manifest-template.json"), "utf8"));
const manifest = { ...template, path: hostPath };
if (browser === "firefox") {
  delete manifest.allowed_origins;
} else {
  manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  delete manifest.allowed_extensions;
}
const target = path.join(dir, template.name + ".json");
const resolved = path.resolve(target);
if (![resolved, launcherPath].every((p) => path.resolve(p).startsWith(path.resolve(home) + path.sep))) { console.error("Refusing to write outside the home folder."); process.exit(2); }

const script = launcherScript(process.execPath, hostScript);
console.log((apply ? "Writing " : "Would write ") + launcherPath + " (mode 0700)");
console.log((apply ? "Writing " : "Would write ") + resolved);
if (!apply) { console.log(script.trimEnd()); console.log(JSON.stringify(manifest, null, 2)); console.log("Run again with --apply to write it."); process.exit(0); }
fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
fs.chmodSync(binDir, 0o700);
fs.writeFileSync(launcherPath, script, { mode: 0o700 });
fs.chmodSync(launcherPath, 0o700);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(resolved, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
fs.chmodSync(resolved, 0o644);
console.log("Done. Restart the browser.");
