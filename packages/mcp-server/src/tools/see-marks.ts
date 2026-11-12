import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { findCommandPath } from "@agenthost/os-linux";

export interface PictureMark {
  n: number;
  /** Box in picture pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MAX_MARKS = 40;

/** The ffmpeg filter chain that draws each box and its number. Exported for tests. */
export function markFilter(marks: PictureMark[]): string {
  return marks.slice(0, MAX_MARKS).flatMap((mark) => {
    const x = Math.max(0, Math.round(mark.x));
    const y = Math.max(0, Math.round(mark.y));
    const w = Math.max(2, Math.round(mark.width));
    const h = Math.max(2, Math.round(mark.height));
    return [
      `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=red@0.9:t=2`,
      `drawtext=text=${mark.n}:x=${x}:y=${Math.max(0, y - 14)}:fontsize=13:fontcolor=white:box=1:boxcolor=red@0.9:boxborderw=2`
    ];
  }).join(",");
}

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error) => resolve(error === null));
  });
}

/**
 * Draws numbered boxes on a JPEG (base64 in, base64 out). Returns undefined when ffmpeg is missing,
 * lacks drawtext, or fails, so the caller can fall back to the plain picture.
 */
export async function drawMarks(agentHostDir: string, jpegBase64: string, marks: PictureMark[]): Promise<string | undefined> {
  if (marks.length === 0) return undefined;
  const ffmpeg = await findCommandPath("ffmpeg").catch(() => undefined);
  if (ffmpeg === undefined) return undefined;
  const dir = path.join(agentHostDir, "screenshots");
  const id = randomUUID();
  const input = path.join(dir, `marks-in-${id}.jpg`);
  const output = path.join(dir, `marks-out-${id}.jpg`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(input, Buffer.from(jpegBase64, "base64"), { mode: 0o600 });
    const ok = await run(ffmpeg, ["-y", "-loglevel", "error", "-i", input, "-vf", markFilter(marks), "-frames:v", "1", "-q:v", "6", output]);
    if (!ok) return undefined;
    return (await readFile(output)).toString("base64");
  } catch {
    return undefined;
  } finally {
    await rm(input, { force: true }).catch(() => undefined);
    await rm(output, { force: true }).catch(() => undefined);
  }
}
