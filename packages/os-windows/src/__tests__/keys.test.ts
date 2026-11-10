import { describe, expect, it } from "vitest";
import { keyToVirtualKey, parseHotkey } from "../keys.js";

describe("key names", () => {
  it("maps modifiers, letters, digits, function and named keys", () => {
    expect(keyToVirtualKey("Ctrl")).toBe(0x11);
    expect(keyToVirtualKey("l")).toBe(0x4c);
    expect(keyToVirtualKey("5")).toBe(0x35);
    expect(keyToVirtualKey("F12")).toBe(0x7b);
    expect(keyToVirtualKey("Return")).toBe(0x0d);
    expect(keyToVirtualKey("pagedown")).toBe(0x22);
    expect(keyToVirtualKey("nonsense")).toBeUndefined();
    expect(keyToVirtualKey("f25")).toBeUndefined();
  });

  it("accepts a list of keys and a plus chord alike", () => {
    expect(parseHotkey(["ctrl", "l"])).toEqual({ ok: true, vks: [0x11, 0x4c] });
    expect(parseHotkey(["ctrl+shift+t"])).toEqual({ ok: true, vks: [0x11, 0x10, 0x54] });
  });

  it("names the unknown key and rejects empty input", () => {
    expect(parseHotkey(["ctrl", "bogus"])).toEqual({ ok: false, reason: 'Unknown key "bogus".' });
    expect(parseHotkey([])).toMatchObject({ ok: false });
  });
});
