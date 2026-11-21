import { acceptConfirmation, alwaysAllowFromConfirmation, listConfirmations, redactSensitiveText, rejectConfirmation, type AlwaysAllowResult } from "@osseo/core";

/*
 * Approve or deny a pending confirmation in the agent's own chat. The request goes through MCP
 * elicitation: the client shows it to the person and only the person can answer. The agent
 * cannot reply to it, so this is not a route for self-approval. The token never appears in the
 * prompt. Clients without elicitation fall back to the cards and `osseo confirm`.
 */

export type ElicitFn = (params: {
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

export interface ChatApprovalInput {
  osseoDir: string;
  sessionId: string;
  tokenId: string;
  elicit: ElicitFn;
}

export type ChatApprovalOutcome = "approved" | "denied" | "dismissed" | "unavailable";

export async function askInChat(input: ChatApprovalInput): Promise<ChatApprovalOutcome> {
  return (await askInChatDetailed(input)).outcome;
}

/** Like askInChat, and also reports what "Always allow here" did when the person ticked it. */
export async function askInChatDetailed(input: ChatApprovalInput): Promise<{ outcome: ChatApprovalOutcome; policy?: AlwaysAllowResult }> {
  const record = (await listConfirmations(input.osseoDir)).find((entry) => entry.tokenId === input.tokenId && entry.sessionId === input.sessionId);
  if (record === undefined || record.status !== "pending") return { outcome: "unavailable" };
  let answer;
  try {
    answer = await input.elicit({
      message: `Osseo needs your approval (${record.riskLevel} risk, ${record.tool}):\n${redactSensitiveText(record.summary).slice(0, 600)}\n\nApproving allows this one exact action, once.`,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve this action", description: "Yes runs the action the next time the agent retries it." },
          alwaysAllow: { type: "boolean", title: "Always allow this kind of action in this app", description: "Writes a rule to policy.toml. Remove it with osseo policy remove." }
        },
        required: ["approve"]
      }
    });
  } catch {
    return { outcome: "unavailable" }; // Client refused or timed out: cards and the CLI still work.
  }
  if (answer.action === "decline") {
    await rejectConfirmation(input.osseoDir, input.tokenId).catch(() => undefined);
    return { outcome: "denied" };
  }
  if (answer.action !== "accept") return { outcome: "dismissed" };
  if (answer.content?.approve === true) {
    const accepted = await acceptConfirmation(input.osseoDir, input.tokenId);
    // Approve once first; the rule is written only when the person also ticked the box.
    if (answer.content.alwaysAllow === true) return { outcome: "approved", policy: await alwaysAllowFromConfirmation(input.osseoDir, accepted) };
    return { outcome: "approved" };
  }
  await rejectConfirmation(input.osseoDir, input.tokenId).catch(() => undefined);
  return { outcome: "denied" };
}
