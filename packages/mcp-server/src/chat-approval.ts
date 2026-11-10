import { acceptConfirmation, listConfirmations, redactSensitiveText, rejectConfirmation } from "@agenthost/core";

/*
 * Approve or deny a pending confirmation in the agent's own chat. The request goes through MCP
 * elicitation: the client shows it to the person and only the person can answer. The agent
 * cannot reply to it, so this is not a route for self-approval. The token never appears in the
 * prompt. Clients without elicitation fall back to the cards and `agenthost confirm`.
 */

export type ElicitFn = (params: {
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;

export interface ChatApprovalInput {
  agentHostDir: string;
  sessionId: string;
  tokenId: string;
  elicit: ElicitFn;
}

export type ChatApprovalOutcome = "approved" | "denied" | "dismissed" | "unavailable";

export async function askInChat(input: ChatApprovalInput): Promise<ChatApprovalOutcome> {
  const record = (await listConfirmations(input.agentHostDir)).find((entry) => entry.tokenId === input.tokenId && entry.sessionId === input.sessionId);
  if (record === undefined || record.status !== "pending") return "unavailable";
  let answer;
  try {
    answer = await input.elicit({
      message: `AgentHost needs your approval (${record.riskLevel} risk, ${record.tool}):\n${redactSensitiveText(record.summary).slice(0, 600)}\n\nApproving allows this one exact action, once.`,
      requestedSchema: {
        type: "object",
        properties: { approve: { type: "boolean", title: "Approve this action", description: "Yes runs the action the next time the agent retries it." } },
        required: ["approve"]
      }
    });
  } catch {
    return "unavailable"; // Client refused or timed out: cards and the CLI still work.
  }
  if (answer.action === "decline") {
    await rejectConfirmation(input.agentHostDir, input.tokenId).catch(() => undefined);
    return "denied";
  }
  if (answer.action !== "accept") return "dismissed";
  if (answer.content?.approve === true) {
    await acceptConfirmation(input.agentHostDir, input.tokenId);
    return "approved";
  }
  await rejectConfirmation(input.agentHostDir, input.tokenId).catch(() => undefined);
  return "denied";
}
