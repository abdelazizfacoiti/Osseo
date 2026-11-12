import type { CapabilityGrant } from "@agenthost/core";
import type { AgentHostMcpContext } from "./context.js";

function cloneGrant(grant: CapabilityGrant): CapabilityGrant {
  return structuredClone(grant);
}

function isGrantActive(grant: CapabilityGrant): boolean {
  return grant.expiresAt === undefined || Date.now() <= Date.parse(grant.expiresAt);
}

export class GrantStore {
  readonly #persistentGrants: CapabilityGrant[];

  constructor(input: { persistentGrants?: CapabilityGrant[] } = {}) {
    this.#persistentGrants = (input.persistentGrants ?? []).map((grant) => cloneGrant(grant));
  }

  listActiveGrants(): CapabilityGrant[] {
    return this.#persistentGrants.filter((grant) => isGrantActive(grant)).map((grant) => cloneGrant(grant));
  }
}

export function createSafetyEvaluationContext(context: AgentHostMcpContext): {
  ownerSessionId: string;
  agentHostDir: string;
  protectedPaths: string[];
  grants: CapabilityGrant[];
  confirmationSatisfied?: boolean;
} {
  return {
    ownerSessionId: context.sessionId,
    agentHostDir: context.config.agentHostDir,
    protectedPaths: [context.config.configPath, context.config.logFile],
    grants: context.grants.listActiveGrants(),
    ...(context.confirmationSatisfied === true ? { confirmationSatisfied: true } : {})
  };
}
