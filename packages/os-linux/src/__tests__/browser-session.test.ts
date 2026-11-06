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
    home = await mkdtemp(path.join(os.tmpdir(), "agenthost-browser-"));
    const file = path.join(home, "page.html");
    const second = path.join(home, "second.html");
    await writeFile(second, "<!doctype html><title>Second tab</title><h1>second</h1>");
    await writeFile(file, PAGE.replace("SECOND_URL", pathToFileURL(second).toString()));
    pageUrl = pathToFileURL(file).toString();
    session = new BrowserSession({ agentHostDir: home });
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

  it("rejects stale refs and follows a link that opens a new tab", async () => {
    const before = await session.snapshot({ maxElements: 50 });
    const stale = before.elements[0]!.ref;
    const fresh = await session.snapshot({ maxElements: 50 });
    expect(await session.click({ ref: stale })).toEqual({ ok: false, reason: "stale_ref" });
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
