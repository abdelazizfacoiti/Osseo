import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttentionChime, attentionSoundEnabled, chimeWav, playerCommand } from "../attention-chime.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const home = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-chime-")); dirs.push(dir); return dir; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("attention chime", () => {
  it("is a short, quiet 16-bit mono WAV", () => {
    const wav = chimeWav();
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    expect(peak).toBeGreaterThan(1000);
    expect(peak / 32767).toBeLessThan(0.35); // soft, never full volume
    expect((wav.length - 44) / 2 / 22_050).toBeLessThan(2);
  });

  it("picks pw-play, then paplay, then aplay on Linux, and a built-in player elsewhere", () => {
    const has = (names: string[]) => (file: string) => names.some((name) => file.endsWith(`/${name}`));
    expect(playerCommand("/x.wav", "linux", has(["pw-play", "aplay"]))?.command).toBe("pw-play");
    expect(playerCommand("/x.wav", "linux", has(["aplay"]))).toEqual({ command: "aplay", args: ["-q", "/x.wav"] });
    expect(playerCommand("/x.wav", "linux", has([]))).toBeUndefined();
    expect(playerCommand("/x.wav", "darwin", has([]))?.command).toBe("afplay");
    expect(playerCommand("C:\\it's.wav", "win32", has([]))?.args.at(-1)).toContain("it''s.wav");
  });

  it("repeats while the person is awaited and stops once answered", async () => {
    let waiting = true;
    const played: string[] = [];
    const chime = new AttentionChime({ agentHostDir: await home(), intervalMs: 30, play: (file) => played.push(file) });
    chime.start(async () => waiting);
    await sleep(120);
    expect(played.length).toBeGreaterThanOrEqual(2);
    expect(played[0]).toMatch(/attention-chime\.wav$/);
    waiting = false;
    await sleep(80);
    const count = played.length;
    await sleep(80);
    expect(played.length).toBe(count);
    expect(chime.active).toBe(false);
  });

  it("stops at the time cap, on stop(), and does nothing when turned off", async () => {
    let clock = 0;
    const played: string[] = [];
    const capped = new AttentionChime({ agentHostDir: await home(), intervalMs: 20, maxMs: 50, now: () => clock, play: (file) => played.push(file) });
    capped.start(async () => true);
    await sleep(40);
    clock = 100;
    await sleep(60);
    expect(capped.active).toBe(false);

    const stopped = new AttentionChime({ agentHostDir: await home(), intervalMs: 20, play: (file) => played.push(file) });
    stopped.start(async () => true);
    stopped.stop();
    expect(stopped.active).toBe(false);

    const off: string[] = [];
    const disabled = new AttentionChime({ agentHostDir: await home(), enabled: false, intervalMs: 10, play: (file) => off.push(file) });
    disabled.start(async () => true);
    await sleep(40);
    expect(off).toHaveLength(0);
  });

  it("is on by default and turned off by config or AGENTHOST_ATTENTION_SOUND=0", () => {
    expect(attentionSoundEnabled({}, {})).toBe(true);
    expect(attentionSoundEnabled({ attention: { sound: false } }, {})).toBe(false);
    expect(attentionSoundEnabled({}, { AGENTHOST_ATTENTION_SOUND: "0" })).toBe(false);
  });
});
