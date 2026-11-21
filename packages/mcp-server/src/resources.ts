import {
  OSSEO_VERSION,
  buildCapabilitiesJson,
  buildCapabilityMarkdown,
  readActiveTaskApproval,
  readActivityStatus,
  readRunState,
  type OsseoConfig,
  type CapabilityRegistrySnapshot,
  type ToolCapability
} from "@osseo/core";
import { COMPUTER_ACTION_FAMILIES } from "./activity.js";
import { DEFAULT_TOOL_NAMES } from "./tool-profile.js";

const CAPABILITY_MIME = "application/json";
const MARKDOWN_MIME = "text/markdown";

function capabilityInput(registry: CapabilityRegistrySnapshot, config: OsseoConfig) {
  const profile = config.tools?.profile ?? "desktop";
  const listed = new Set<string>(DEFAULT_TOOL_NAMES);
  // The desktop profile lists only the default tools; the rest stay callable but are not advertised.
  const tools = registry.listTools().filter((tool) => profile === "full" || listed.has(tool.name));
  const byExecutionClass = tools.reduce<Record<string, number>>((counts, tool) => {
    const name = tool.execution?.executionClass ?? "unclassified";
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  const mode = config.overlay?.mode ?? "always";
  return {
    version: OSSEO_VERSION,
    toolCount: tools.length,
    toolProfile: profile,
    byExecutionClass,
    overlay: {
      mode,
      triggers: mode === "off" ? [] : mode === "on_change" ? ["state-changing actions"] : COMPUTER_ACTION_FAMILIES.map((family) => `${family}.*`),
      fallback: "osseo overlay status"
    }
  };
}

export function listResourceEntries(): Array<{ uri: string; name: string; mimeType: string; description: string }> {
  return [
    { uri: "osseo://capabilities", name: "Osseo capabilities (JSON)", mimeType: CAPABILITY_MIME, description: "Live tool inventory, execution classes, and capability families." },
    { uri: "osseo://capabilities.md", name: "Osseo capabilities (Markdown)", mimeType: MARKDOWN_MIME, description: "Compact agent-facing capability brief generated from the live tool inventory." },
    { uri: "osseo://status", name: "Osseo run status", mimeType: CAPABILITY_MIME, description: "Live stop, takeover, pause, active task approval, and last activity overlay state." }
  ];
}

export async function readResource(
  context: { registry: CapabilityRegistrySnapshot; config: OsseoConfig },
  uri: string
): Promise<{ mimeType: string; text: string }> {
  const input = capabilityInput(context.registry, context.config);
  if (uri === "osseo://capabilities") {
    return { mimeType: CAPABILITY_MIME, text: JSON.stringify(buildCapabilitiesJson(input), null, 2) };
  }
  if (uri === "osseo://capabilities.md") {
    return { mimeType: MARKDOWN_MIME, text: buildCapabilityMarkdown(input) };
  }
  if (uri === "osseo://status") {
    const [runState, approval, activity] = await Promise.all([
      readRunState(context.config.osseoDir),
      readActiveTaskApproval(context.config.osseoDir),
      readActivityStatus(context.config.osseoDir)
    ]);
    return {
      mimeType: CAPABILITY_MIME,
      text: JSON.stringify({
        version: OSSEO_VERSION,
        runState,
        activeTaskApproval: approval ?? null,
        lastActivity: activity ?? null
      }, null, 2)
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

export type { ToolCapability };
