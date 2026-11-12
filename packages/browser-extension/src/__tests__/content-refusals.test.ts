import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module
import { fieldRefusal } from "../refusals.mjs";

const root = path.resolve(__dirname, "../..");
const f = (o: Record<string, string>) => ({ tag: "input", type: "text", autocomplete: "", name: "", id: "", ...o });

describe("fieldRefusal", () => {
  it("refuses password fields", () => {
    expect(fieldRefusal(f({ type: "password" }))).toBe("password_field");
    expect(fieldRefusal(f({ type: "PASSWORD" }))).toBe("password_field");
  });
  it("refuses one-time-code and card autocomplete", () => {
    for (const ac of ["one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "section-pay cc-number", "current-password"]) {
      expect(fieldRefusal(f({ autocomplete: ac })), ac).toBe("sensitive_autocomplete");
    }
  });
  it("refuses sensitive names and ids", () => {
    for (const name of ["password", "passcode", "otp", "api_token", "secret", "cardNumber", "cvv", "cvc", "iban", "ssn"]) {
      expect(fieldRefusal(f({ name })), name).toBe("sensitive_name");
      expect(fieldRefusal(f({ id: name })), "id " + name).toBe("sensitive_name");
    }
  });
  it("refuses in textarea and select too", () => {
    expect(fieldRefusal({ ...f({ name: "otp" }), tag: "textarea" })).toBe("sensitive_name");
  });
  it("allows ordinary fields and non-fields", () => {
    expect(fieldRefusal(f({ name: "Name", id: "name" }))).toBeNull();
    expect(fieldRefusal(f({ name: "email", autocomplete: "email" }))).toBeNull();
    expect(fieldRefusal({ tag: "button", type: "", autocomplete: "", name: "cardholder", id: "" })).toBeNull();
  });
  it("refuses 'tokenizer' on purpose: the name pattern is deliberately broad", () => {
    expect(fieldRefusal(f({ name: "tokenizer" }))).toBe("sensitive_name");
  });
});

describe("content script copy", () => {
  const block = (text: string) => text.slice(text.indexOf("// BEGIN refusals"), text.indexOf("// END refusals"));
  const dedent = (s: string) => s.split("\n").map((l) => l.replace(/^\s+/, "")).join("\n");
  it("matches src/refusals.mjs line for line, ignoring indentation", () => {
    const a = dedent(block(fs.readFileSync(path.join(root, "src/refusals.mjs"), "utf8")));
    const b = dedent(block(fs.readFileSync(path.join(root, "extension/content.js"), "utf8")));
    expect(a.length).toBeGreaterThan(200);
    expect(b).toBe(a);
  });
});
