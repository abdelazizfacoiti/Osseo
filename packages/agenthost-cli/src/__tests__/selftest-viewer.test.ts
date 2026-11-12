import { afterEach, describe, expect, it } from "vitest";
import { selftestCommand } from "../selftest.js";

// The viewer self-test refuses before it starts anything when it cannot run. These cases never start a server or a viewer.
describe("agenthost selftest --viewer preconditions", () => {
  const savedDisplay = process.env.DISPLAY;

  afterEach(() => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  it("refuses without a screen (DISPLAY unset) and says where to run it", async () => {
    delete process.env.DISPLAY;
    const out = await selftestCommand(["--viewer"], "/unused-home", {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("DISPLAY is not set");
  });

  it("refuses without a built server when a screen is set", async () => {
    process.env.DISPLAY = ":41";
    const out = await selftestCommand(["--viewer"], "/unused-home", { mcpEntry: "/nonexistent/index.js" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("built server not found");
  });
});
