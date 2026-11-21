import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module
import { claimSocket, socketAnswers } from "../../host/native-host.mjs";
// @ts-expect-error plain .mjs module
import { launcherScript, shellQuote } from "../../host/launcher.mjs";

const root = path.resolve(__dirname, "../..");
const temps: string[] = [];
const servers: net.Server[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ahx-test-")); temps.push(d); return d; };
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const listen = (sock: string) => new Promise<net.Server>((resolve) => { const s = net.createServer((c) => c.on("error", () => {})); servers.push(s); s.listen(sock, () => resolve(s)); });

describe("single host owns the socket", () => {
  it("a live owner is left alone: no unlink, no listen", async () => {
    const sock = path.join(tmp(), "run", "b.sock");
    fs.mkdirSync(path.dirname(sock));
    await listen(sock);
    const inode = fs.statSync(sock).ino;
    expect(await socketAnswers(sock, 500)).toBe(true);
    expect(await claimSocket(sock, 500)).toEqual({ owner: false });
    expect(fs.existsSync(sock)).toBe(true);
    expect(fs.statSync(sock).ino).toBe(inode);
    // the first owner still accepts connections
    expect(await socketAnswers(sock, 500)).toBe(true);
  });
  it("a stale socket (owner killed, file left behind) is removed and the caller becomes owner", async () => {
    const sock = path.join(tmp(), "b.sock");
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)},()=>console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((r) => child.stdout.once("data", r));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(fs.existsSync(sock)).toBe(true);
    expect(await socketAnswers(sock, 500)).toBe(false);
    expect(await claimSocket(sock, 500)).toEqual({ owner: true });
    expect(fs.existsSync(sock)).toBe(false);
  });
  it("a plain stale file counts as stale; a missing socket makes the caller owner", async () => {
    const dir = tmp();
    const sock = path.join(dir, "x", "b.sock");
    expect(await claimSocket(sock, 200)).toEqual({ owner: true });
    fs.writeFileSync(sock, "");
    expect(await claimSocket(sock, 200)).toEqual({ owner: true });
    expect(fs.existsSync(sock)).toBe(false);
  });
});

describe("reconnect backoff", () => {
  it("doubles from 1 s and caps at 60 s", () => {
    const text = fs.readFileSync(path.join(root, "extension/background.js"), "utf8");
    const block = text.slice(text.indexOf("// BEGIN backoff"), text.indexOf("// END backoff"));
    const backoffDelay = new Function(block + "; return backoffDelay;")() as (n: number) => number;
    const seq = Array.from({ length: 10 }, (_, i) => backoffDelay(i) / 1000);
    expect(seq).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    expect(backoffDelay(-3)).toBe(1000);
  });
});

describe("launcher", () => {
  it("quotes spaces and single quotes for sh", () => {
    const weird = "/tmp/a b/it's here/native-host.mjs";
    expect(shellQuote(weird)).toBe("'/tmp/a b/it'\\''s here/native-host.mjs'");
    const dir = tmp();
    const script = path.join(dir, "l.sh");
    const marker = path.join(dir, "it's a dir");
    fs.mkdirSync(marker);
    const fake = path.join(marker, "fake node");
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s" "$0" "$1"\n', { mode: 0o755 });
    const hostFile = path.join(marker, "native host's.mjs");
    fs.writeFileSync(script, launcherScript(fake, hostFile), { mode: 0o755 });
    expect(launcherScript("/n", "/h")).toBe("#!/bin/sh\nexec '/n' '/h'\n");
    expect(execFileSync(script, { encoding: "utf8" })).toBe(`${fake}|${hostFile}`);
  });
});

describe("install-host", () => {
  const run = (home: string, ...extra: string[]) =>
    execFileSync(process.execPath, [path.join(root, "host/install-host.mjs"), "--browser", "chrome", "--extension-id", "a".repeat(32), ...extra], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  it("preview writes nothing", () => {
    const home = tmp();
    const out = run(home);
    expect(out).toContain("Would write");
    expect(fs.readdirSync(home)).toEqual([]);
  });
  it("apply writes the launcher 0700 and the manifest 0644 pointing at it", () => {
    const home = tmp();
    run(home, "--apply");
    const bin = path.join(home, ".osseo", "browser-extension", "bin");
    const launcher = path.join(bin, "osseo-browser-host");
    expect(fs.statSync(bin).mode & 0o777).toBe(0o700);
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o700);
    const text = fs.readFileSync(launcher, "utf8");
    expect(text).toBe(launcherScript(process.execPath, path.join(root, "host/native-host.mjs")));
    const mf = path.join(home, ".config", "google-chrome", "NativeMessagingHosts", "dev.osseo.browser.json");
    expect(fs.statSync(mf).mode & 0o777).toBe(0o644);
    const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
    expect(manifest.path).toBe(launcher);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${"a".repeat(32)}/`]);
  });
});
