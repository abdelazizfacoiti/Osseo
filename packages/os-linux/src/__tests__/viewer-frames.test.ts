import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findXephyr, startBackgroundDisplay } from "../background-display.js";
import { captureDisplayFrame } from "../viewer-frames.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "osseo-frames-"));
function fakeCommand(body: string): string {
  const file = path.join(tmp(), "fake-scrot");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("captureDisplayFrame (no display)", () => {
  it("refuses a bad display string without running a command", async () => {
    const marker = path.join(tmp(), "ran");
    const command = fakeCommand(`touch ${marker}`);
    for (const bad of ["", "90", ":9;rm", ":0 -x", "$(id)", ":1\n"]) {
      expect(await captureDisplayFrame(bad, { directory: tmp(), command })).toEqual({ ok: false, reason: "bad_display" });
    }
    expect(() => statSync(marker)).toThrow();
  });

  it("refuses an unsafe file name", async () => {
    expect(await captureDisplayFrame(":90", { directory: tmp(), fileName: "../x.png" })).toMatchObject({ reason: "bad_file_name" });
  });

  it("honours the timeout", async () => {
    const command = fakeCommand("sleep 5");
    const started = Date.now();
    const result = await captureDisplayFrame(":90", { directory: tmp(), command, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("reports a failing and an empty capture", async () => {
    expect(await captureDisplayFrame(":90", { directory: tmp(), command: fakeCommand("exit 3") })).toMatchObject({ ok: false, reason: "capture_failed" });
    expect(await captureDisplayFrame(":90", { directory: tmp(), command: fakeCommand('touch "$2"') })).toMatchObject({ ok: false, reason: "empty" });
  });

  it("writes the frame with mode 0600 in a 0700 directory and passes DISPLAY", async () => {
    const directory = path.join(tmp(), "frames");
    const command = fakeCommand('printf "$DISPLAY" > "$2"');
    const result = await captureDisplayFrame(":91", { directory, command });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readFileSync(result.path, "utf8")).toBe(":91");
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});

function has(command: string, args: string[]): boolean { try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; } }
const nestedAvailable = findXephyr() !== undefined && Boolean(process.env.DISPLAY) && has("xdotool", ["version"]) && has("scrot", ["--version"]);

describe.skipIf(!nestedAvailable)("captureDisplayFrame on a nested display", () => {
  let nested: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }>;
  beforeAll(async () => {
    const started = await startBackgroundDisplay({ width: 640, height: 400, firstDisplay: 116 });
    if (!started.ok) throw new Error(started.reason);
    nested = started;
  }, 30_000);
  afterAll(async () => { await nested?.stop(); });

  it("returns a non-empty PNG", async () => {
    const result = await captureDisplayFrame(nested.display, { directory: tmp() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bytes).toBeGreaterThan(100);
      expect(readFileSync(result.path).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  }, 20_000);
});
