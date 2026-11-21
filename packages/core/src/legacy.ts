/*
 * Osseo was called AgentHost before the rename. Existing installs keep working:
 * - AGENTHOST_* environment variables are read as OSSEO_* when the new one is not set;
 * - ~/.agenthost and ~/.config/agenthost are used while the new folders do not exist yet.
 */
export const LEGACY_HOME_DIRNAME = ".agenthost";
export const LEGACY_CONFIG_DIRNAME = "agenthost";

/** Copies AGENTHOST_X to OSSEO_X when OSSEO_X is unset. Call once at every process entry point. */
export function applyLegacyEnv(env: Record<string, string | undefined> = process.env): void {
  for (const key of Object.keys(env)) {
    if (!key.startsWith("AGENTHOST_")) continue;
    const next = `OSSEO_${key.slice("AGENTHOST_".length)}`;
    if (env[next] === undefined && env[key] !== undefined) env[next] = env[key];
  }
}

// Every Osseo process (CLI, server, host, renderer helpers) imports this package before it reads its environment, so the
// aliasing happens once, here. It only fills in variables that are not already set.
applyLegacyEnv();
