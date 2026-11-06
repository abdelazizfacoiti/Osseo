import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RiskLevel } from "./types.js";
import type { ConfirmationRecord } from "./confirmations.js";
import { redactSensitiveText } from "./safety/redaction.js";

/*
 * Optional phone approvals over a channel the operator chose (ntfy-style
 * publish and poll URLs). AgentHost only makes outbound requests; it opens no
 * listener.
 *
 * An agent runs as the same user, so anything secret stored here it could read.
 * The machine therefore holds only salted hashes of one-time codes. The codes
 * themselves exist once, shown to the person at pairing, so a reply cannot be
 * forged from this computer. A code works once and only for the request named
 * in its reply. Pairing itself needs a real-pointer press on a card.
 */

export const PHONE_CODE_COUNT = 20;
const MAX_FAILED_REPLIES = 5;
const REPLY = /^\s*(approve|deny)\s+([a-f0-9]{6})\s+([a-z2-7]{10})\s*$/i;
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export type PhoneMaxRisk = "medium" | "high";

export interface PhonePairing {
  version: 1;
  publishUrl: string;
  pollUrl: string;
  maxRisk: PhoneMaxRisk;
  salt: string;
  /** Unused code hashes. */
  codes: string[];
  failedReplies: number;
  disabled: boolean;
  pairedAt: string;
}

export interface PhoneReply { decision: "approve" | "deny"; ref: string; code: string }

/** A channel URL must be https; plain http is allowed only for loopback. */
export function isValidChannelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
  } catch {
    return false;
  }
}

/** Lives in run/, the control plane, so agent file tools cannot write it. */
function pairingPath(agentHostDir: string): string { return path.join(agentHostDir, "run", "phone.json"); }

function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code.toLowerCase()}`).digest("hex");
}

function newCode(): string {
  return [...randomBytes(10)].map((byte) => CODE_ALPHABET[byte % 32]).join("");
}

async function write(agentHostDir: string, pairing: PhonePairing): Promise<void> {
  const target = pairingPath(agentHostDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pairing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function readPhonePairing(agentHostDir: string): Promise<PhonePairing | undefined> {
  try {
    const value = JSON.parse(await readFile(pairingPath(agentHostDir), "utf8")) as PhonePairing;
    return value.version === 1 && Array.isArray(value.codes) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a pairing and returns the plain codes. They are never stored or shown again. */
export async function createPhonePairing(agentHostDir: string, input: { publishUrl: string; pollUrl: string; maxRisk?: PhoneMaxRisk }): Promise<{ pairing: PhonePairing; codes: string[] }> {
  if (!isValidChannelUrl(input.publishUrl) || !isValidChannelUrl(input.pollUrl)) throw new Error("phone_channel_url_invalid: use https");
  const salt = randomBytes(16).toString("hex");
  const codes = Array.from({ length: PHONE_CODE_COUNT }, newCode);
  const pairing: PhonePairing = { version: 1, publishUrl: input.publishUrl, pollUrl: input.pollUrl, maxRisk: input.maxRisk ?? "medium", salt, codes: codes.map((code) => hashCode(salt, code)), failedReplies: 0, disabled: false, pairedAt: new Date().toISOString() };
  await write(agentHostDir, pairing);
  return { pairing, codes };
}

export async function removePhonePairing(agentHostDir: string): Promise<void> {
  await rm(pairingPath(agentHostDir), { force: true });
}

/** Spends a code. Repeated wrong codes disable the channel until the person pairs again. */
export async function consumePhoneCode(agentHostDir: string, code: string): Promise<boolean> {
  const pairing = await readPhonePairing(agentHostDir);
  if (pairing === undefined || pairing.disabled) return false;
  const candidate = Buffer.from(hashCode(pairing.salt, code), "hex");
  const index = pairing.codes.findIndex((stored) => {
    const value = Buffer.from(stored, "hex");
    return value.length === candidate.length && timingSafeEqual(value, candidate);
  });
  if (index < 0) {
    const failedReplies = pairing.failedReplies + 1;
    await write(agentHostDir, { ...pairing, failedReplies, disabled: failedReplies >= MAX_FAILED_REPLIES });
    return false;
  }
  await write(agentHostDir, { ...pairing, codes: pairing.codes.filter((_stored, position) => position !== index), failedReplies: 0 });
  return true;
}

export function parsePhoneReply(message: string): PhoneReply | undefined {
  const match = REPLY.exec(message);
  return match === null ? undefined : { decision: match[1]!.toLowerCase() as PhoneReply["decision"], ref: match[2]!.toLowerCase(), code: match[3]!.toLowerCase() };
}

/** Short public reference for a request. The token itself never leaves the machine. */
export function phoneRequestRef(tokenId: string): string {
  return createHash("sha256").update(tokenId).digest("hex").slice(0, 6);
}

export function phoneCovers(pairing: PhonePairing, risk: RiskLevel): boolean {
  return risk === "medium" || risk === "low" || (risk === "high" && pairing.maxRisk === "high");
}

/** The redacted preview does go to the channel: the person cannot decide without it. */
export function formatPhoneRequest(record: ConfirmationRecord): string {
  const ref = phoneRequestRef(record.tokenId);
  return `AgentHost asks to: ${redactSensitiveText(record.summary).slice(0, 300)}\nTool ${record.tool}, ${record.riskLevel} risk. Check this against what you asked for.\nReply: approve ${ref} <code>  or  deny ${ref} <code>`;
}
