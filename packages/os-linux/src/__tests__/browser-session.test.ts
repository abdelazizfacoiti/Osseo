import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, findChromeExecutable } from "../browser-session.js";

const chrome = findChromeExecutable();
const PAGE = `<!doctype html><title>Probe page</title><body>
<h1>Sign up</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted:' + document.getElementById('name').value">
  <input id="name" placeholder="Your name">
  <input id="pw" type="password" placeholder="Password">
  <input id="otp" autocomplete="one-time-code" placeholder="Code">
  <button type="submit">Send form</button>
</form>
<button id="inc" onclick="document.getElementById('count').textContent = Number(document.getElementById('count').textContent) + 1">Add one</button>
<span id="count">0</span><p id="out"></p>
<a id="tab" href="SECOND_URL" target="_blank">Open second</a>
<div style="display:none"><button>Hidden</button></div>
</body>`;

describe.skipIf(chrome === undefined)("BrowserSession (real headless Chrome)", () => {
  let home: string;
  let session: BrowserSession;
  let pageUrl: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "osseo-browser-"));
    const file = path.join(home, "page.html");
    const second = path.join(home, "second.html");
    await writeFile(second, "<!doctype html><title>Second tab</title><h1>second</h1>");
    await writeFile(file, PAGE.replace("SECOND_URL", pathToFileURL(second).toString()));
    pageUrl = pathToFileURL(file).toString();
    session = new BrowserSession({ osseoDir: home });
  });
  afterAll(async () => {
    await session.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 90_000);

  it("opens a page, lists visible interactive elements with refs, and hides password values", async () => {
    const opened = await session.open({ url: pageUrl, headless: true });
    expect(opened).toMatchObject({ opened: true, title: "Probe page", headless: true });
    const snapshot = await session.snapshot({ maxElements: 50 });
    const names = snapshot.elements.map((element) => element.name);
    expect(names).toEqual(expect.arrayContaining(["Your name", "Send form", "Add one", "Open second"]));
    expect(names).not.toContain("Hidden");
    expect(snapshot.text).toContain("Sign up");
    expect(snapshot.elements.every((element) => /^s\d+-e\d+$/.test(element.ref))).toBe(true);
  }, 90_000);

  it("types, clicks, and refuses sensitive fields", async () => {
    const snapshot = await session.snapshot({ maxElements: 50 });
    const ref = (name: string) => snapshot.elements.find((element) => element.name === name)!.ref;
    expect(await session.type({ ref: ref("Your name"), text: "Ada" })).toMatchObject({ ok: true });
    expect(await session.type({ ref: ref("Password"), text: "hunter2" })).toEqual({ ok: false, reason: "sensitive_field" });
    expect(await session.type({ ref: ref("Code"), text: "123456" })).toEqual({ ok: false, reason: "sensitive_field" });
    expect((await session.describe({ ref: ref("Send form") }))).toMatchObject({ isSubmit: true, formHasPassword: true });
    expect(await session.click({ ref: ref("Add one") })).toMatchObject({ ok: true });
    expect(await session.click({ ref: ref("Send form") })).toMatchObject({ ok: true });
    const after = await session.snapshot({ maxElements: 50 });
    expect(after.text).toContain("submitted:Ada");
    expect(after.text).toMatch(/\n?1\b/);
    // The password never appears in snapshots, even though a value was refused.
    expect(JSON.stringify(after)).not.toContain("hunter2");
  }, 90_000);

  it("keeps a ref for the same element across snapshots, so an approval for it can still be used", async () => {
    const first = await session.snapshot({ maxElements: 50 });
    const second = await session.snapshot({ maxElements: 50 });
    expect(second.elements.map((element) => element.ref)).toEqual(first.elements.map((element) => element.ref));
    expect(new Set(second.elements.map((element) => element.ref)).size).toBe(second.elements.length);
  }, 90_000);

  it("rejects stale refs and follows a link that opens a new tab", async () => {
    // A ref from another document never resolves, even though element numbers repeat.
    const old = (await session.snapshot({ maxElements: 50 })).elements[0]!.ref;
    expect(await session.navigate({ action: "reload" })).toMatchObject({ ok: true });
    const fresh = await session.snapshot({ maxElements: 50 });
    expect(fresh.elements[0]!.ref).not.toBe(old);
    expect(await session.click({ ref: old })).toEqual({ ok: false, reason: "stale_ref" });
    const link = fresh.elements.find((element) => element.name === "Open second")!;
    expect(await session.click({ ref: link.ref })).toMatchObject({ ok: true, title: "Second tab" });
    expect((await session.snapshot({ maxElements: 10 })).text).toContain("second");
  }, 90_000);

  it("navigates back and reports a closed browser", async () => {
    expect(await session.navigate({ action: "goto", url: pageUrl })).toMatchObject({ ok: true, title: "Probe page" });
    expect(await session.navigate({ action: "reload" })).toMatchObject({ ok: true });
    await session.close();
    expect(await session.state()).toBeUndefined();
    expect(await session.click({ ref: "s1-e0" })).toEqual({ ok: false, reason: "browser_not_open" });
  }, 90_000);
});

describe.skipIf(chrome === undefined)("BrowserSession forms (real headless Chrome)", () => {
  let home: string;
  let session: BrowserSession;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "osseo-forms-"));
    const file = path.join(home, "form.html");
    await writeFile(file, `<!doctype html><title>Form</title>
      <input type="file" id="f" onchange="document.getElementById('msg').textContent = 'files:' + this.files.length">
      <select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <input id="name" placeholder="Name"><p id="msg">ready</p>`);
    session = new BrowserSession({ osseoDir: home });
    await session.open({ url: pathToFileURL(file).toString(), headless: true });
  }, 60_000);

  afterAll(async () => {
    await session.close();
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });

  it("gives a new ref when an element's label changes, when it is replaced, and none outside the latest snapshot", async () => {
    await session.navigate({ action: "reload" });
    const page = session as unknown as { snapshot: BrowserSession["snapshot"] };
    const before = await page.snapshot({ maxElements: 50 });
    const input = before.elements.find((element) => element.name === "Name")!;
    // Listed by an earlier, longer snapshot but not by the latest one.
    const shorter = await page.snapshot({ maxElements: 1 });
    expect(shorter.elements).toHaveLength(1);
    const run = (script: string) => session.navigate({ action: "goto", url: `javascript:${encodeURIComponent(script)};void 0` });
    await run("document.getElementById('name').placeholder = 'Delete account'");
    const relabelled = (await page.snapshot({ maxElements: 50 })).elements.find((element) => element.name === "Delete account")!;
    expect(relabelled.ref).not.toBe(input.ref);
    expect(await session.readValue({ ref: input.ref })).toBeUndefined();
    await run("const n = document.getElementById('name'); n.replaceWith(n.cloneNode(true))");
    const replaced = (await page.snapshot({ maxElements: 50 })).elements.find((element) => element.name === "Delete account")!;
    expect(replaced.ref).not.toBe(relabelled.ref);
    await run("document.getElementById('name').placeholder = 'Name'");
  }, 60_000);

  it("uploads a file, selects an option, waits for text, reads values back, and captures an image", async () => {
    const upload = path.join(home, "upload.txt");
    await writeFile(upload, "hello");
    const snap = await session.snapshot({ maxElements: 50 });
    const fileRef = snap.elements.find((element) => element.type === "file")!.ref;
    const selectRef = snap.elements.find((element) => element.tag === "select")!.ref;
    const nameRef = snap.elements.find((element) => element.name === "Name")!.ref;

    expect(await session.upload({ ref: fileRef, files: [upload] })).toMatchObject({ ok: true });
    expect(await session.waitFor({ text: "files:1", timeoutMs: 5_000 })).toMatchObject({ matched: true });
    expect(await session.select({ ref: selectRef, label: "Beta" })).toMatchObject({ ok: true, selected: "Beta" });
    expect(await session.select({ ref: selectRef, label: "Gamma" })).toMatchObject({ ok: false, reason: "option_not_found", options: ["Alpha", "Beta"] });
    await session.type({ ref: nameRef, text: "Ada", clear: true });
    expect(await session.readValue({ ref: nameRef })).toBe("Ada");
    const image = await session.screenshot({ ref: nameRef });
    expect(image.ok).toBe(true);
    expect(image.image?.data.length ?? 0).toBeGreaterThan(200);
    expect((await session.waitFor({ text: "never-appears", timeoutMs: 300 })).matched).toBe(false);
  }, 60_000);
});


describe("chromeSpawnOptions", () => {
  it("hides the window only for headless, so a headed Chrome on Windows is visible", async () => {
    const { chromeSpawnOptions } = await import("../browser-session.js");
    const env = { PATH: "x" };
    expect(chromeSpawnOptions(true, env)).toEqual({ stdio: "ignore", env, windowsHide: true });
    expect(chromeSpawnOptions(false, env)).toEqual({ stdio: "ignore", env });
    expect("windowsHide" in chromeSpawnOptions(false, env)).toBe(false);
  });
});
