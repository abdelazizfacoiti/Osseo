import { describe, expect, it } from "vitest";
import { pasteKeyFor } from "../desktop.js";

describe("paste key for the focused app", () => {
  it("pastes with Ctrl+V in ordinary apps, Ctrl+Shift+V in terminals, and Shift+Insert in xterm", () => {
    expect(pasteKeyFor("firefox")).toBe("ctrl+v");
    expect(pasteKeyFor("gnome-terminal-")).toBe("ctrl+shift+v");
    expect(pasteKeyFor("Konsole")).toBe("ctrl+shift+v");
    expect(pasteKeyFor("xterm")).toBe("shift+Insert");
    expect(pasteKeyFor(undefined)).toBe("ctrl+v");
  });
});
