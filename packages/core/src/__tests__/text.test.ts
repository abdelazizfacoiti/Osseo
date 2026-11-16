import { describe, expect, it } from "vitest";
import { stripBom } from "../index.js";

describe("stripBom", () => {
  it("removes one leading byte-order mark and nothing else", () => {
    expect(stripBom("﻿{\"a\":1}")).toBe("{\"a\":1}");
    expect(stripBom("{\"a\":1}")).toBe("{\"a\":1}");
    expect(stripBom("a﻿b")).toBe("a﻿b");
    expect(stripBom("")).toBe("");
  });
});
