import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeDir = fileURLToPath(new URL("../../runtime/", import.meta.url));

describe("Teach-mode card on a nested display", () => {
  // Starts its own Xephyr on a free display number (40-89), never :0. A real pointer press cannot be made
  // here, so this checks the card, its three buttons, its place beside the box, and that a synthetic press
  // on Next or Back is ignored. Skips (exit 77) without Xephyr or python3-gi.
  it.skipIf(!process.env.DISPLAY)("shows Back and Next, sits beside its box, and ignores synthetic presses", () => {
    const result = spawnSync("python3", [`${runtimeDir}teach_selftest.py`], { encoding: "utf8", timeout: 90_000 });
    if (result.status === 77) return;
    expect(result.stdout + result.stderr).toContain("RESULT PASS");
    expect(result.status).toBe(0);
  });

  it("the renderer file still compiles", () => {
    const result = spawnSync("python3", ["-m", "py_compile", `${runtimeDir}gtk3-renderer.py`], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });
});
