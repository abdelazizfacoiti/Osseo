import type { AgentCapability } from "./capability-permissions.js";

export const CAPABILITY_FAMILY_SUMMARIES: Record<AgentCapability, { summary: string; exampleTools: string[] }> = {
  computer: { summary: "Observe and verify machine state; wait for UI conditions.", exampleTools: ["computer.observe_state", "computer.wait_for", "desktop.screenshot"] },
  browser: { summary: "Optional paired browser bridge; browser tools are absent unless that adapter is installed and enabled.", exampleTools: [] },
  filesystem: { summary: "Read, write, copy, move, and approval-gated delete inside policy roots.", exampleTools: ["file.read", "file.write", "file.copy", "file.move", "file.delete"] },
  shell: { summary: "Classified command execution with timeouts, output limits, and control-plane path blocks.", exampleTools: ["shell.run"] },
  applications: { summary: "Open apps and discover installed ones.", exampleTools: ["app.open", "app.open_url"] },
  mcp: { summary: "System, policy, capability, and task discovery.", exampleTools: ["system.list_capabilities", "system.get_info", "task.list"] },
  network: { summary: "No open network tool is loaded by default; the browser tools reach only pages in the dedicated profile.", exampleTools: [] },
  vision: { summary: "Local OCR grounding with image-relative targets; suggestions only, no automatic pointer action.", exampleTools: ["vision.find_target", "vision.find_text"] },
  ocr: { summary: "Local Tesseract text extraction on approved images.", exampleTools: ["vision.analyze_image", "vision.find_text"] },
  speech: { summary: "Optional speech adapter; tools are absent unless that adapter is installed and enabled.", exampleTools: [] },
  skills: { summary: "Portable skill documents are installed on disk, not exposed as a live MCP resource.", exampleTools: ["task.create", "task.list"] }
};

export interface OverlayActivityBrief {
  mode: "always" | "on_change" | "off";
  triggers: string[];
  fallback: string;
}

export interface CapabilityManifestInput {
  version: string;
  /** Omit for static briefs (CLI paste-into-config); live resources always fill it. */
  toolCount?: number;
  byExecutionClass?: Record<string, number>;
  /** "desktop" lists the short numbered tool set; "full" (or omitted) the whole inventory. */
  toolProfile?: "desktop" | "full";
  overlay?: OverlayActivityBrief;
}

/** One small pull for agent clients (Codex, Claude Code, Copilot, OpenCode)
 * instead of ingesting hundreds of tool schemas up front. */
const DESKTOP_BRIEF_TOOLS = "see, click, type, key, scroll, drag, open, windows, wait, ask, steps, status, guide.show, guide.clear";

function buildDesktopMarkdown(input: CapabilityManifestInput): string {
  const inventory = input.toolCount === undefined ? "live tool inventory via MCP" : `${input.toolCount} tools`;
  const overlay = input.overlay === undefined
    ? ""
    : `\nActivity overlay: mode \`${input.overlay.mode}\`; ${input.overlay.triggers.length === 0 ? "automatic cards are disabled" : `automatic cards cover ${input.overlay.triggers.join(", ")}`}. Fallback status: \`${input.overlay.fallback}\`.\n`;
  return `# AgentHost capabilities (v${input.version}, ${inventory}, profile desktop)

Tools: ${DESKTOP_BRIEF_TOOLS}.

Loop: \`see\` returns numbered elements of a window ([1] button "Save"). Act by number with
\`click\`, \`type\`, \`scroll\`, \`drag\`, or press \`key\`. Call \`see\` again after anything changes:
numbers are only valid for the view that issued them. For web tasks \`open\` a url (the agent's own
browser gives exact element refs). Use \`guide.show\` for sensitive apps and \`ask\` for logins,
MFA, captchas and payments. \`steps\` runs a short plan; \`wait\` waits for text or a window.

Sensitive fields show as (blocked) and are never read or typed into. Sends, uploads, deletes and
payments return confirmation_required with a token: repeat the same call with confirmationToken
once the person approves. Credential and security apps and protected paths stay blocked.
\`agent.stop\` flags are read with \`status\`; only the operator clears them.

Other tools (files, shell, tasks, memory, ui.*, vision.*) stay callable by name and are listed when
\`tools.profile\` is \`full\`.
${overlay}`;
}

export function buildCapabilityMarkdown(input: CapabilityManifestInput): string {
  if (input.toolProfile === "desktop") return buildDesktopMarkdown(input);
  const families = (Object.keys(CAPABILITY_FAMILY_SUMMARIES) as AgentCapability[])
    .map((family) => {
      const info = CAPABILITY_FAMILY_SUMMARIES[family];
      return `- **${family}**: ${info.summary}${info.exampleTools.length > 0 ? ` (e.g. ${info.exampleTools.join(", ")})` : ""}`;
    })
    .join("\n");
  const classes = Object.entries(input.byExecutionClass ?? {})
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
  const inventory = input.toolCount === undefined
    ? "live tool inventory via MCP"
    : `${input.toolCount} tools${classes.length > 0 ? ` [${classes}]` : ""}`;
  const overlay = input.overlay === undefined
    ? ""
    : `\nActivity overlay: mode \`${input.overlay.mode}\`; ${input.overlay.triggers.length === 0 ? "automatic cards are disabled" : `automatic cards cover ${input.overlay.triggers.join(", ")}`}. Fallback status: \`${input.overlay.fallback}\`.\n`;
  return `# AgentHost capabilities (v${input.version}, ${inventory})

AgentHost is a local general-purpose computer-use runtime. Work the loop:
understand, plan, inspect, act, observe, verify, recover. Tool errors are
recoverable, never terminal.

${families}

Execution model: routine local actions (click, type, focus, screenshot,
file edit, shell, app launch) execute directly under one autonomous policy.
External sends/uploads, destructive actions, and private-data access require
an exact single-use confirmation bound to the current input and target.
Credential, security, and protected system paths stay blocked. An active
task approval may cover bounded low/medium work; high and blocked effects
never auto-chain. Task and agent control metadata are exempt. \`agent.stop\`
sets the emergency stop and revokes task approval; only the operator CLI
clears stop/takeover/pause flags. Tasks (\`task.*\`) organize long work. Pull
\`agenthost://status\` for live stop/takeover state before starting.
${overlay}
Definition of done: record observable criteria with \`task.create\`
(\`definitionOfDone\`), verify each one, then call \`task.update_status\`
with \`status: "completed"\` and \`verifiedCriteria\` listing every criterion.
Completion is refused while any criterion is unverified. When the requested
outcome is visible, stop and report instead of repeating the same call; the
runtime warns when an identical call repeats.

Operator controls: the action card stays on top for approvals, exposes
Pause/Resume/Stop, and its close button works even after the MCP server exits.
\`agenthost agent pause\` / \`resume --pause\` set and clear the pause gate.

Fast lane (fewer turns, fewer tokens): pull \`agenthost://capabilities.md\`
first instead of \`tools/list\`; fold window observation into one
\`computer.observe_state\` call; use \`computer.wait_for\` instead of fixed
sleeps; do not pause for routine local confirmations. Ask for confirmation
only at the exact consequential boundary.
`;
}

export function buildCapabilitiesJson(input: CapabilityManifestInput): Record<string, unknown> {
  return {
    product: "agenthost",
    version: input.version,
    ...(input.toolCount === undefined ? {} : { toolCount: input.toolCount }),
    ...(input.byExecutionClass === undefined ? {} : { byExecutionClass: input.byExecutionClass }),
    ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
    families: CAPABILITY_FAMILY_SUMMARIES,
    loop: ["understand", "plan", "inspect", "act", "observe", "verify", "recover"],
    resources: ["agenthost://capabilities", "agenthost://capabilities.md", "agenthost://status"]
  };
}
