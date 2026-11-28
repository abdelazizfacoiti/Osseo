/*
 * `osseo setup guide`: the first-run path in one command. It never installs anything and never edits a
 * client's config; it reports what is ready, runs the self-test, and prints the exact next command for each step.
 *
 *   1. Home     the Osseo folder and config exist (made by `setup`)
 *   2. Desktop  system packages for desktop control (Linux); missing ones come with the command that installs them
 *   3. Self-test the built server fills a local form in headless Chrome (a few seconds, no window). It does not
 *               touch the desktop, so on Windows the Desktop step starts the desktop helper on its own.
 *   4. Clients  which agent clients are on this machine, and whether Osseo is registered with each
 *   5. Try it   one safe first prompt to paste into the agent
 */

export interface GuideClient {
  target: string;
  label: string;
  installed: boolean;
  registered: boolean;
  /** The exact command that registers this client. Defaults to `osseo integrations <target> add --apply`. */
  registerCommand?: string;
  /** How to confirm the client now lists Osseo. */
  verifyCommand?: string;
}
export interface GuideDeps {
  platform: NodeJS.Platform;
  homeLabel: string;
  /** Names of desktop packages that are missing, and the command that installs them. Linux only. */
  requirements?: () => Promise<{ missing: string[]; command: string }>;
  selftest: () => Promise<{ ok: boolean; summary: string; failedStep?: string }>;
  clients: () => Promise<GuideClient[]>;
  /** Windows only: whether the Windows cards are on (OSSEO_WINDOWS_OVERLAY=1 or overlay.windows in config.json). */
  windowsCards?: { enabled: boolean };
  /** Windows only: whether the desktop helper starts. The self-test uses the headless browser and cannot tell. */
  windowsDesktop?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface GuideResult {
  ok: boolean;
  lines: string[];
  steps: Array<{ name: string; status: "ok" | "todo" | "fail" | "skipped"; detail: string }>;
}

export const FIRST_PROMPT = "Use Osseo to open https://example.com in its own browser, then call see and tell me the page title and the numbered controls. Do not click anything.";

function registerLines(client: GuideClient): string[] {
  const lines = [`Register ${client.label}: ${client.registerCommand ?? `osseo integrations ${client.target} add --apply`}`];
  if (client.verifyCommand !== undefined) lines.push(`Then check it: ${client.verifyCommand}`);
  return lines;
}

export async function runGuide(deps: GuideDeps): Promise<GuideResult> {
  const steps: GuideResult["steps"] = [];
  const lines: string[] = ["Osseo first run", ""];
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
      add("Desktop", "skipped", "Could not check the desktop packages. Run: osseo doctor");
    }
  } else if (deps.platform === "win32" && deps.windowsDesktop !== undefined) {
    const desktop = await deps.windowsDesktop().catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : "The desktop check failed." }));
    if (desktop.ok) add("Desktop", "ok", "Desktop control starts.");
    else add("Desktop", "fail", desktop.reason);
  } else {
    add("Desktop", "skipped", "No package check on this system. Run: osseo doctor");
  }
  const desktopFailed = steps.some((step) => step.name === "Desktop" && step.status === "fail");

  let selftestOk = false;
  try {
    const test = await deps.selftest();
    selftestOk = test.ok;
    if (test.ok) add("Self-test", "ok", `${test.summary} (agent browser only)`);
    else add("Self-test", "fail", test.failedStep === undefined ? test.summary : `Failed at "${test.failedStep}". ${test.summary}`, ["Run it again for the full report: osseo selftest"]);
  } catch (error) {
    add("Self-test", "fail", error instanceof Error ? error.message : "selftest_failed", ["Run it again for the full report: osseo selftest"]);
  }

  // The cards are a separate, opt-in switch on Windows. There is no true/false switch for overlay.mode.
  if (deps.platform === "win32" && deps.windowsCards !== undefined) {
    if (deps.windowsCards.enabled) add("Cards", "ok", "Windows cards are on: action, task and approval cards draw on screen.");
    else add("Cards", "todo", "Windows cards are off.", ["Turn them on: add \"windows\": true under \"overlay\" in config.json, or set OSSEO_WINDOWS_OVERLAY=1.", "overlay.mode is always, on_change or off. There is no true/false switch for it; always shows the cards for computer actions."]);
  }

  let clients: GuideClient[] = [];
  try {
    clients = await deps.clients();
  } catch {
    clients = [];
  }
  const present = clients.filter((client) => client.installed || client.registered);
  if (present.length === 0) {
    add("Clients", "todo", "No agent client found on this machine.", ["Install one (Claude Code, Codex, opencode, Cursor or Copilot), then run: osseo setup guide"]);
  } else if (present.some((client) => client.registered)) {
    add("Clients", "ok", present.map((client) => `${client.label} ${client.registered ? "registered" : "not registered"}`).join(", ") + ".",
      present.filter((client) => !client.registered).flatMap(registerLines));
  } else {
    add("Clients", "todo", `${present.map((client) => client.label).join(", ")} found, Osseo not registered yet.`,
      present.flatMap(registerLines));
  }

  lines.push("");
  const registered = clients.some((client) => client.registered);
  if (selftestOk && desktopFailed) {
    lines.push("The agent browser works. Desktop control does NOT work: see Desktop above.");
    lines.push(registered ? "Browser tasks can still be tried. Restart your agent client, then paste this:" : "To try browser tasks, register a client (above), restart it, then paste this:", `  ${FIRST_PROMPT}`);
  } else if (selftestOk && registered) {
    lines.push("Ready. Restart your agent client, then paste this:", `  ${FIRST_PROMPT}`);
  } else if (selftestOk) {
    lines.push("The server works. Register it with your agent client (above), restart the client, then paste this:", `  ${FIRST_PROMPT}`);
  } else {
    lines.push("Fix the failed step first, then run: osseo setup guide");
  }
  lines.push("If something fails, the reasons are recorded: osseo failures");
  lines.push("Sends, uploads, deletes and payments ask you first.");
  if (deps.platform !== "win32") lines.push("Pause and Stop stay on screen.");
  else if (deps.windowsCards?.enabled === true) lines.push("Cards show Pause and Stop, but a real click on Stop is not yet confirmed on Windows. You can always run: osseo agent stop");
  else lines.push("Windows cards are off, so there is no Pause or Stop on screen. To stop the agent run: osseo agent stop");
  return { ok: selftestOk && !desktopFailed, lines, steps };
}
