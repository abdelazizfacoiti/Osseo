import { describe, expect, it } from "vitest";
import { FIRST_PROMPT, runGuide, type GuideDeps } from "../guide.js";

const passing: GuideDeps = {
  platform: "linux",
  homeLabel: "The Osseo folder",
  requirements: async () => ({ missing: [], command: "osseo setup deps --apply" }),
  selftest: async () => ({ ok: true, summary: "Selftest passed: 6 of 6 steps in 1900 ms." }),
  clients: async () => [{ target: "claude", label: "Claude Code", installed: true, registered: true }]
};

describe("osseo setup guide", () => {
  it("is ready when the self-test passes and a client is registered", async () => {
    const result = await runGuide(passing);
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(result.lines.join("\n")).toContain(FIRST_PROMPT);
    expect(result.lines.join("\n")).toContain("Ready.");
  });

  it("names missing packages with the command that installs them, without installing", async () => {
    const result = await runGuide({ ...passing, requirements: async () => ({ missing: ["xdotool", "scrot"], command: "osseo setup deps --apply" }) });
    expect(result.steps[1]).toMatchObject({ name: "Desktop", status: "todo" });
    expect(result.lines.join("\n")).toContain("Missing: xdotool, scrot.");
    expect(result.lines.join("\n")).toContain("osseo setup deps --apply");
  });

  it("fails and sends the person to the report when the self-test fails, with no first prompt", async () => {
    const result = await runGuide({ ...passing, selftest: async () => ({ ok: false, summary: "Selftest failed: 2 of 6 steps passed.", failedStep: "open" }) });
    expect(result.ok).toBe(false);
    const text = result.lines.join("\n");
    expect(text).toContain('Failed at "open"');
    expect(text).toContain("osseo selftest");
    expect(text).toContain("Fix the failed step first");
    expect(text).not.toContain(FIRST_PROMPT);
  });

  it("treats a thrown self-test as a failure", async () => {
    const result = await runGuide({ ...passing, selftest: async () => { throw new Error("built server not found"); } });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("built server not found");
  });

  it("prints the register command for an installed client that is not registered", async () => {
    const result = await runGuide({ ...passing, clients: async () => [
      { target: "claude", label: "Claude Code", installed: true, registered: false },
      { target: "codex", label: "Codex", installed: false, registered: false }
    ] });
    const text = result.lines.join("\n");
    expect(result.steps[3]).toMatchObject({ name: "Clients", status: "todo" });
    expect(text).toContain("osseo integrations claude add --apply");
    expect(text).not.toContain("integrations codex add");
    expect(result.ok).toBe(true);
    expect(text).toContain("Register it with your agent client");
  });

  it("uses a client's own register and verify commands when it has them", async () => {
    const result = await runGuide({ ...passing, clients: async () => [{ target: "claude", label: "Claude Code", installed: true, registered: false, registerCommand: 'claude mcp add osseo --scope user -- node "C:\\Osseo\\index.js"', verifyCommand: "claude mcp list" }] });
    const text = result.lines.join("\n");
    expect(text).toContain('claude mcp add osseo --scope user -- node "C:\\Osseo\\index.js"');
    expect(text).toContain("Then check it: claude mcp list");
    expect(text).not.toContain("integrations claude add");
    expect(text).toContain("osseo failures");
  });

  it("tells a Windows person how to turn the cards on, and that overlay.mode has no true/false switch", async () => {
    const result = await runGuide({ ...passing, platform: "win32", windowsCards: { enabled: false } });
    expect(result.steps.find((step) => step.name === "Cards")?.status).toBe("todo");
    const text = result.lines.join("\n");
    expect(text).toContain('"windows": true');
    expect(text).toContain("no true/false switch");
  });

  it("reports the Windows cards as on when the switch is set", async () => {
    const result = await runGuide({ ...passing, platform: "win32", windowsCards: { enabled: true } });
    expect(result.steps.find((step) => step.name === "Cards")?.status).toBe("ok");
  });

  it("says so when no client is installed", async () => {
    const result = await runGuide({ ...passing, clients: async () => [{ target: "claude", label: "Claude Code", installed: false, registered: false }] });
    expect(result.lines.join("\n")).toContain("No agent client found");
  });

  it("skips the package check off Linux and when the check itself fails", async () => {
    expect((await runGuide({ ...passing, platform: "win32" })).steps[1]?.status).toBe("skipped");
    expect((await runGuide({ ...passing, requirements: async () => { throw new Error("apt"); } })).steps[1]?.status).toBe("skipped");
  });
});
