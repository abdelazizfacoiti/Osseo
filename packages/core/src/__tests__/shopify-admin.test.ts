import { describe, expect, it } from "vitest";
import { classifyAppSensitivity, evaluateSafety, getDefaultPolicy, isShopifyAdminUrl, shopifyAdminAskCategory } from "../index.js";

const ctx = { homeDir: "/home/tester" };
const click = (url: string, targetName?: string, extra: Record<string, unknown> = {}) =>
  evaluateSafety({ tool: "browser.click", actionType: "browser_action", appName: "Chrome", url, ...(targetName === undefined ? {} : { targetName }), ...extra } as never, getDefaultPolicy(), ctx);
const read = (url: string, actionType: "observe" | "inspect" | "browser_action" = "observe") =>
  evaluateSafety({ tool: "browser.snapshot", actionType, appName: "Chrome", url }, getDefaultPolicy(), ctx);

describe("Shopify store admin: ask before sends, allow navigation", () => {
  it("recognises only the named hosts and paths", () => {
    expect(isShopifyAdminUrl("https://admin.shopify.com/")).toBe(true);
    expect(isShopifyAdminUrl("https://admin.shopify.com/store/demo/products")).toBe(true);
    expect(isShopifyAdminUrl("https://demo.myshopify.com/admin/products")).toBe(true);
    expect(isShopifyAdminUrl("https://demo.myshopify.com/products")).toBe(false);
    expect(isShopifyAdminUrl("https://example.com/admin")).toBe(false);
    expect(isShopifyAdminUrl("https://accounts.shopify.com/lookup")).toBe(false);
    expect(isShopifyAdminUrl("https://admin.shopify.com/login")).toBe(false);
  });

  it("reads and navigates admin pages without a block or prompt", () => {
    for (const url of ["https://admin.shopify.com/", "https://admin.shopify.com/store/demo/products", "https://demo.myshopify.com/admin/products"]) {
      for (const type of ["observe", "inspect", "browser_action"] as const) {
        const r = read(url, type);
        expect(r.blocked, `${type} ${url}`).toBe(false);
        expect(r.appSensitivity).not.toBe("credential_or_security");
        expect(r.approval.required).toBe(false);
        expect(r.requiresConfirmationToken).toBe(false);
      }
      const plain = click(url, "Products");
      expect(plain.blocked).toBe(false);
      expect(plain.approval.required).toBe(false);
    }
  });

  it("asks before delete, send and payment controls", () => {
    for (const name of ["Delete product", "Remove variant", "Send invoice", "Email customer", "Upload image", "Pay now", "Refund order", "Charge card", "Capture payment"]) {
      const r = click("https://admin.shopify.com/store/demo/orders/1", name);
      expect(r.blocked, name).toBe(false);
      expect(r.approval.required, name).toBe(true);
      expect(r.requiresConfirmationToken, name).toBe(true);
      expect(r.allowed, name).toBe(false);
    }
  });

  it("does not ask for a plain Save, nor when no name is known", () => {
    const save = click("https://admin.shopify.com/store/demo/products/1", "Save");
    expect(save.approval.required).toBe(false);
    expect(save.requiresConfirmationToken).toBe(false);
    const unnamed = click("https://admin.shopify.com/store/demo/products/1");
    expect(unnamed.approval.required).toBe(false);
  });

  it("keeps the name words in one function", () => {
    expect(shopifyAdminAskCategory("Delete")).toBe("delete");
    expect(shopifyAdminAskCategory("Upload")).toBe("upload");
    expect(shopifyAdminAskCategory("Refund")).toBe("pay");
    expect(shopifyAdminAskCategory("Send")).toBe("send");
    expect(shopifyAdminAskCategory("Save")).toBeUndefined();
    expect(shopifyAdminAskCategory(undefined)).toBeUndefined();
  });

  it("keeps login, password and authentication pages blocked", () => {
    for (const url of ["https://accounts.shopify.com/lookup", "https://admin.shopify.com/login", "https://admin.shopify.com/auth/callback", "https://demo.myshopify.com/admin/login", "https://demo.myshopify.com/admin/auth/login", "https://demo.myshopify.com/admin/password", "https://demo.myshopify.com/admin/passwords"]) {
      expect(classifyAppSensitivity({ appName: "Chrome", url }), url).toBe("credential_or_security");
      expect(click(url, "Continue").blocked, url).toBe(true);
    }
  });

  it("refuses a password field on an admin page", () => {
    const r = click("https://admin.shopify.com/store/demo/settings", "Password", { dataSensitivity: "secret" });
    expect(r.blocked).toBe(true);
  });

  it("blocks /admin on other hosts exactly as before", () => {
    for (const url of ["https://example.com/admin", "https://example.com/admin/users", "https://demo.myshopify.com.evil.example/admin"]) {
      expect(classifyAppSensitivity({ appName: "Chrome", url }), url).toBe("credential_or_security");
      expect(click(url, "Save").blocked, url).toBe(true);
    }
  });
});
