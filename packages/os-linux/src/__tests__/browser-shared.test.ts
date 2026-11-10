import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, findChromeExecutable } from "../browser-session.js";

const chrome = findChromeExecutable();

describe.skipIf(chrome === undefined)("BrowserSession sharing one profile", () => {
  let home: string;
  let first: BrowserSession;
  let second: BrowserSession;
  let pageUrl: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agenthost-browser-shared-"));
    const file = path.join(home, "page.html");
    await writeFile(file, "<!doctype html><title>Shared probe</title><h1>hello</h1>");
    pageUrl = pathToFileURL(file).toString();
    first = new BrowserSession({ agentHostDir: home });
    second = new BrowserSession({ agentHostDir: home });
  });
  afterAll(async () => {
    await second.close();
    await first.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 90_000);

  it("a second session opens its own tab in the browser that already owns the profile", async () => {
    expect((await first.open({ url: pageUrl, headless: true })).opened).toBe(true);
    const opened = await second.open({ url: pageUrl, headless: true });
    expect(opened).toMatchObject({ opened: true, title: "Shared probe" });
    await second.close();
    // Closing the second session leaves the first one's browser alive.
    expect(await first.state()).toMatchObject({ title: "Shared probe" });
  }, 60_000);
});
