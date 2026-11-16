/*
 * `agenthost setup guide`: the first-run path in one command. It never installs anything and never edits a
 * client's config; it reports what is ready, runs the self-test, and prints the exact next command for each step.
 *
 *   1. Home     the AgentHost folder and config exist (made by `setup`)
 *   2. Desktop  system packages for desktop control (Linux); missing ones come with the command that installs them
 *   3. Self-test the built server fills a local form in headless Chrome (a few seconds, no window)
 *   4. Clients  which agent clients are on this machine, and whether AgentHost is registered with each
 *   5. Try it   one safe first prompt to paste into the agent
 */

export interface GuideClient { target: string; label: string; installed: boolean; registered: boolean }
export interface GuideDeps {
  platform: NodeJS.Platform;
  homeLabel: string;
  /** Names of desktop packages that are missing, and the command that installs them. Linux only. */
  requirements?: () => Promise<{ missing: string[]; command: string }>;
  selftest: () => Promise<{ ok: boolean; summary: string; failedStep?: string }>;
  clients: () => Promise<GuideClient[]>;
}

export interface GuideResult {
  ok: boolean;
  lines: string[];
  steps: Array<{ name: string; status: "ok" | "todo" | "fail" | "skipped"; detail: string }>;
}

export const FIRST_PROMPT = "Use AgentHost to open https://example.com in its own browser, then call see and tell me the page title and the numbered controls. Do not click anything.";

export async function runGuide(deps: GuideDeps): Promise<GuideResult> {
  const steps: GuideResult["steps"] = [];
  const lines: string[] = ["AgentHost first run", ""];
  const add = (name: string, status: GuideResult["steps"][number]["status"], detail: string, extra: string[] = []) => {
    steps.push({ name, status, detail });
    const mark = status === "ok" ? "OK  " : status === "fail" ? "FAIL" : status === "skipped" ? "SKIP" : "TODO";
    lines.push(`${mark}  ${name.padEnd(10)} ${detail}`);
    for (const extraLine of extra) lines.push(`      ${extraLine}`);
  };

  add("Home", "ok", `${deps.homeLabel} is ready.`);

  if (deps.platform === "linux" && deps.requirements !== undefined) {
    try {
      const need = await deps.requirements();
      if (need.missing.length === 0) add("Desktop", "ok", "Every desktop package is installed.");
      else add("Desktop", "todo", `Missing: ${need.missing.join(", ")}.`, [`Install them (asks for your password): ${need.command}`]);
    } catch {
      add("Desktop", "skipped", "Could not check the desktop packages. Run: agenthost doctor");
    }
  } else {
    add("Desktop", "skipped", "No package check on this system. Run: agenthost doctor");
  }

  let selftestOk = false;
  try {
    const test = await deps.selftest();
    selftestOk = test.ok;
    if (test.ok) add("Self-test", "ok", test.summary);
    else add("Self-test", "fail", test.failedStep === undefined ? test.summary : `Failed at "${test.failedStep}". ${test.summary}`, ["Run it again for the full report: agenthost selftest"]);
  } catch (error) {
    add("Self-test", "fail", error instanceof Error ? error.message : "selftest_failed", ["Run it again for the full report: agenthost selftest"]);
  }

  let clients: GuideClient[] = [];
  try {
    clients = await deps.clients();
  } catch {
    clients = [];
  }
  const present = clients.filter((client) => client.installed || client.registered);
  if (present.length === 0) {
    add("Clients", "todo", "No agent client found on this machine.", ["Install one (Claude Code, Codex, opencode, Cursor or Copilot), then run: agenthost setup guide"]);
  } else if (present.some((client) => client.registered)) {
    add("Clients", "ok", present.map((client) => `${client.label} ${client.registered ? "registered" : "not registered"}`).join(", ") + ".",
      present.filter((client) => !client.registered).map((client) => `Register ${client.label}: agenthost integrations ${client.target} add --apply`));
  } else {
    add("Clients", "todo", `${present.map((client) => client.label).join(", ")} found, AgentHost not registered yet.`,
      present.map((client) => `Register ${client.label}: agenthost integrations ${client.target} add --apply`));
  }

  lines.push("");
  const registered = clients.some((client) => client.registered);
  if (selftestOk && registered) {
    lines.push("Ready. Restart your agent client, then paste this:", `  ${FIRST_PROMPT}`);
  } else if (selftestOk) {
    lines.push("The server works. Register it with your agent client (above), restart the client, then paste this:", `  ${FIRST_PROMPT}`);
  } else {
    lines.push("Fix the failed step first, then run: agenthost setup guide");
  }
  lines.push("Sends, uploads, deletes and payments ask you first. Pause and Stop stay on screen.");
  return { ok: selftestOk, lines, steps };
}
