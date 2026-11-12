import type { AppSensitivity, SafetyInput } from "../types.js";

const COMMUNICATION_PATTERNS = [
  /\bgmail\b/i,
  /\boutlook\b/i,
  /\bslack\b/i,
  /\bdiscord\b/i,
  /\bwhatsapp\b/i,
  /\btelegram\b/i,
  /\bsignal\b/i,
  /\bteams\b/i,
  /\bemail\b/i,
  /\bmail\b/i
];

const FINANCIAL_PATTERNS = [
  /\bbank/i,
  /\bcheckout\b/i,
  /\bpayment\b/i,
  /\bpaypal\b/i,
  /\bstripe\b/i,
  /\bcrypto\b/i,
  /\bwallet\b/i,
  /\bcoinbase\b/i,
  /\bbinance\b/i,
  /\bkraken\b/i,
  /\bmetamask\b/i,
  /\bledger\b/i,
  /\btrezor\b/i
];

const CREDENTIAL_OR_SECURITY_PATTERNS = [
  /\b1password\b/i,
  /\bbitwarden\b/i,
  /\bkeepass/i,
  /\blastpass\b/i,
  /\bpassword\b/i,
  /\bsecret\b/i,
  /\bcredential\b/i,
  /\bkeyring\b/i,
  /\bseahorse\b/i,
  /\bssh\b/i,
  /\bgnupg\b/i,
  /\bgpg\b/i,
  /\bsecurity\b/i,
  /\bauthenticator\b/i
];

const SYSTEM_SETTINGS_PATTERNS = [
  /\bsettings\b/i,
  /\bcontrol panel\b/i,
  /\bgnome-control-center\b/i,
  /\bsystem preferences\b/i,
  /\bdconf\b/i,
  /\bgsettings\b/i,
  /\bnetworkmanager\b/i,
  /\bpackage manager\b/i,
  /\bsoftware updater\b/i
];

const URL_SECURITY_PATTERNS = [/\/login\b/i, /\/signin\b/i, /\/mfa\b/i, /\/2fa\b/i, /\/security\b/i, /\/admin\b/i, /\/console\b/i];

const NORMAL_APP_PATTERNS = [
  /\bblender\b/i,
  /\bgimp\b/i,
  /\blibreoffice\b/i,
  /\bwriter\b/i,
  /\bcalc\b/i,
  /\bcode\b/i,
  /\bvscode\b/i,
  /\bvisual studio code\b/i,
  /\bterminal\b/i
];

function combinedInput(input: Pick<SafetyInput, "appId" | "appName" | "url">): string {
  return [input.appId, input.appName, input.url].filter((value): value is string => typeof value === "string").join(" ");
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

let userBlockedApps: string[] = [];

/**
 * Apps the operator never wants automated (config `blockedApps`). Matching is a
 * case-insensitive substring of the app id, name, or URL, and a match is
 * treated exactly like a credential/security app: blocked for control and reads.
 */
export function setUserBlockedApps(names: readonly string[]): void {
  userBlockedApps = names.map((name) => name.trim().toLowerCase()).filter((name) => name.length >= 2);
}

export function isUserBlockedApp(input: Pick<SafetyInput, "appId" | "appName" | "url">): boolean {
  if (userBlockedApps.length === 0) return false;
  const value = combinedInput(input).toLowerCase();
  return value.length > 0 && userBlockedApps.some((name) => value.includes(name));
}

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

/** Login, password and authentication paths stay blocked, also on a store admin host. */
const SHOPIFY_AUTH_PATH = /\/(?:login|auth|passwords?)(?:\/|$|[^a-z0-9])/i;

/**
 * A Shopify store admin page: host `admin.shopify.com`, or a `*.myshopify.com` host whose path
 * starts with `/admin`. Login, password and authentication pages (any path containing `/login`,
 * `/auth`, `/password` or `/passwords`, and the host `accounts.shopify.com`) are not store admin.
 */
export function isShopifyAdminUrl(url: string | undefined): boolean {
  const parsed = parseUrl(url);
  if (parsed === undefined) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (SHOPIFY_AUTH_PATH.test(path)) return false;
  if (host === "admin.shopify.com") return true;
  return host.endsWith(".myshopify.com") && (path === "/admin" || path.startsWith("/admin/"));
}

/**
 * The element-name check for store admin pages, in one place. A control whose name contains one of
 * these words is a named category and asks first; any other name is an ordinary state change.
 *   delete: delete, remove          upload: upload
 *   pay:    pay, refund, charge, capture
 *   send:   send, email
 * Returns undefined when the name is absent or matches none of them.
 */
export function shopifyAdminAskCategory(name: string | undefined): "delete" | "upload" | "pay" | "send" | undefined {
  if (name === undefined || !/send|email|upload|delete|remove|pay|refund|charge|capture/i.test(name)) return undefined;
  if (/delete|remove/i.test(name)) return "delete";
  if (/upload/i.test(name)) return "upload";
  if (/pay|refund|charge|capture/i.test(name)) return "pay";
  return "send";
}

export function classifyAppSensitivity(input: Pick<SafetyInput, "appId" | "appName" | "url">): AppSensitivity {
  const value = combinedInput(input);

  // Store admin consoles are not a security page: reading and navigating are allowed.
  if (isShopifyAdminUrl(input.url) && !isUserBlockedApp(input)) {
    const appOnly = combinedInput({ appId: input.appId, appName: input.appName } as Pick<SafetyInput, "appId" | "appName" | "url">);
    return matchesAny(appOnly, CREDENTIAL_OR_SECURITY_PATTERNS) ? "credential_or_security" : "normal";
  }
  if (parseUrl(input.url)?.hostname.toLowerCase() === "accounts.shopify.com") return "credential_or_security";

  if (value.trim().length === 0) {
    return "unknown";
  }

  if (isUserBlockedApp(input) || matchesAny(value, CREDENTIAL_OR_SECURITY_PATTERNS)) {
    return "credential_or_security";
  }

  if (matchesAny(value, URL_SECURITY_PATTERNS)) return "credential_or_security";

  if (matchesAny(value, FINANCIAL_PATTERNS)) {
    return "financial";
  }

  if (matchesAny(value, COMMUNICATION_PATTERNS)) {
    return "communication";
  }

  if (matchesAny(value, SYSTEM_SETTINGS_PATTERNS)) {
    return "system_settings";
  }

  if (matchesAny(value, NORMAL_APP_PATTERNS)) {
    return "normal";
  }

  return "unknown";
}
