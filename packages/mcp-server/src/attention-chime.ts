import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * A soft chime that repeats while Osseo waits for the person (an approval, or a hand-off such as a login).
 * Two quiet sine notes with a slow fade, every `intervalMs`, until `stillWaiting()` says the wait is over, `stop()` is
 * called, or `maxMs` passes. It never blocks a tool call and fails silently when no player exists.
 */

export interface AttentionChimeOptions {
  osseoDir: string;
  /** Default true. `attention.sound: false` in config, or OSSEO_ATTENTION_SOUND=0, turns it off. */
  enabled?: boolean;
  intervalMs?: number;
  maxMs?: number;
  platform?: NodeJS.Platform;
  /** Test seams. */
  play?: (file: string) => void;
  exists?: (file: string) => boolean;
  now?: () => number;
}

const SAMPLE_RATE = 22_050;

/** 16-bit mono WAV: two gentle notes (C5 then G5), each with a short attack and an exponential fade. */
export function chimeWav(): Buffer {
  const seconds = 1.4;
  const count = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Int16Array(count);
  const notes = [{ hz: 523.25, start: 0 }, { hz: 783.99, start: 0.16 }];
  for (let i = 0; i < count; i += 1) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (const note of notes) {
      const local = t - note.start;
      if (local < 0) continue;
      const attack = Math.min(1, local / 0.012);
      const decay = Math.exp(-local * 3.2);
      // A quiet octave partial makes it sound like a soft bell, not a beep.
      value += attack * decay * (Math.sin(2 * Math.PI * note.hz * local) + 0.25 * Math.sin(4 * Math.PI * note.hz * local));
    }
    samples[i] = Math.round(Math.max(-1, Math.min(1, value * 0.16)) * 32767);
  }
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The command that plays a WAV file on this platform, or undefined when none is installed. */
export function playerCommand(file: string, platform: NodeJS.Platform, exists: (file: string) => boolean): { command: string; args: string[] } | undefined {
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`] };
  if (platform === "darwin") return { command: "afplay", args: [file] };
  for (const [command, args] of [["pw-play", [file]], ["paplay", [file]], ["aplay", ["-q", file]]] as const) {
    if (["/usr/bin", "/bin", "/usr/local/bin"].some((dir) => exists(path.join(dir, command)))) return { command, args: [...args] };
  }
  return undefined;
}

export function attentionSoundEnabled(config: { attention?: { sound?: boolean } }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OSSEO_ATTENTION_SOUND === "0") return false;
  return config.attention?.sound !== false;
}

export class AttentionChime {
  readonly #options: Required<Pick<AttentionChimeOptions, "intervalMs" | "maxMs">> & AttentionChimeOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #startedAt = 0;
  #file: string | undefined;

  constructor(options: AttentionChimeOptions) {
    this.#options = { intervalMs: 8_000, maxMs: 300_000, ...options };
  }

  get active(): boolean { return this.#timer !== undefined; }

  /** Starts chiming (once; a second start while active only keeps the current loop). */
  start(stillWaiting: () => Promise<boolean>): void {
    if (this.#options.enabled === false || this.#timer !== undefined) return;
    const now = this.#options.now ?? Date.now;
    this.#startedAt = now();
    const tick = async (): Promise<void> => {
      if (this.#timer === undefined) return;
      const waiting = await stillWaiting().catch(() => false);
      if (!waiting || now() - this.#startedAt > this.#options.maxMs) { this.stop(); return; }
      await this.#play().catch(() => undefined);
      if (this.#timer !== undefined) this.#timer = setTimeout(() => { void tick(); }, this.#options.intervalMs);
    };
    this.#timer = setTimeout(() => { void tick(); }, 0);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #play(): Promise<void> {
    if (this.#file === undefined) {
      const dir = path.join(this.#options.osseoDir, "run");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      this.#file = path.join(dir, "attention-chime.wav");
      await writeFile(this.#file, chimeWav(), { mode: 0o600 });
    }
    if (this.#options.play !== undefined) { this.#options.play(this.#file); return; }
    const player = playerCommand(this.#file, this.#options.platform ?? process.platform, this.#options.exists ?? existsSync);
    if (player === undefined) return;
    const child: ChildProcess = nodeSpawn(player.command, player.args, { stdio: "ignore", detached: false, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
  }
}
