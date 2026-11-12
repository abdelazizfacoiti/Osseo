/*
 * Usage text for the operator CLI. Kept apart from index.ts so it can be tested
 * without running the dispatcher. Help never runs a command and never touches
 * the runtime directory, so `agenthost <anything> --help` is always safe.
 */

export const TOP_USAGE = "agenthost version|doctor|setup|start|stop|status|task|confirmations|confirm|deny|agent|attention|workflow|schedule|memory|policy|replay|viewer|journal|host|shortcut|selftest|capabilities|permissions|sessions|overlay|integrations|config|update|uninstall|help";

export const COMMAND_USAGE: Record<string, string> = {
  version: "agenthost version",
  doctor: "agenthost doctor [--json]",
  setup: "agenthost setup [--resume] | agenthost setup deps [--apply]",
  start: "agenthost start",
  stop: "agenthost stop",
  status: "agenthost status",
  task: "agenthost task list | status <id> | watch <id> [--follow] [--notify] [--overlay] | approve <id> [--max-risk low|medium] | pause <id> | resume <id> | export <id> [--format md|html]",
  confirmations: "agenthost confirmations [list]",
  confirm: "agenthost confirm <tokenId> [--always]\n  --always also writes one rule to policy.toml so this kind of action in this app needs no prompt next time.",
  deny: "agenthost deny <tokenId>",
  agent: "agenthost agent status | pause [--reason text] | stop [--reason text] | takeover-begin [--reason text] | resume [--stop] [--takeover] [--pause]\n  resume with no flag clears a pause, and names any stop or takeover still active with its exact command.",
  attention: "agenthost attention request --source <client> --reason <permission|confirmation|idle|done> | clear [--restore] | status",
  workflow: "agenthost workflow list | show <name> | run <name> [--param k=v] [--unattended] | delete <name>",
  schedule: "agenthost schedule list | add <workflow> (--daily HH:MM | --weekdays HH:MM | --every 30m) [--param k=v] [--apply] | remove <workflow> [--apply]",
  memory: "agenthost memory list | delete <id> | clear [--yes]",
  selftest: "agenthost selftest [--json]. Prove this install works: start the built server, fill a local form in headless Chrome with see, type and click, check the values. A few seconds; no window opens.",
  shortcut: "agenthost shortcut status | install [--binding <accelerator>] [--apply] | remove [--apply]. GNOME Stop shortcut (default Ctrl+Shift+Alt+Esc) that runs agent stop; preview unless --apply.",
  host: "agenthost host status | start | stop. The per-user host that MCP clients use when AGENTHOST_HOST=1. status shows pid, socket and connected sessions; start launches it detached and refuses if one is running; stop asks it to exit through its socket.",
  journal: "agenthost journal show [--session <id>] | save <name> [--session <id>] [--last <n>] [--description <text>] [--apply]. Saves the steps the agent took through numbered actions as a workflow; typed text becomes parameters, never values. Run it with agenthost workflow run <name> --param text_1=...",
  viewer: "agenthost viewer start [--display :N] | stop | status. Opens a small live view of the background display with Pause, Resume and Stop.",
  replay: "agenthost replay build [--session <id> | --task <id> | --last] [--out <file>] | list | open <id> | delete <id> [--apply]",
  policy: "agenthost policy list [--json] | add --action <a> --decision <allow|ask|never> [--app <name>] [--site <host>] [--note <text>] [--apply] | remove <line> [--apply]",
  capabilities: "agenthost capabilities [--markdown]",
  permissions: "agenthost permissions",
  sessions: "agenthost sessions",
  overlay: "agenthost overlay status | hide [--orphans] | check-input",
  integrations: "agenthost integrations <client> add|status|remove [--apply]",
  config: "agenthost config show | validate",
  update: "agenthost update --archive <file> [--sha256 <hex>] [--apply] | agenthost update --rollback [--apply]",
  uninstall: "agenthost uninstall [--yes] [--remove-data]",
  help: "agenthost help [command]"
};

/** True when help was requested anywhere on the line, or the line starts with `help`. */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.some((item) => item === "--help" || item === "-h") || argv[0] === "help" || argv[argv.length - 1] === "help";
}

/** The usage line for an argv that asked for help: the named command, or the full list. */
export function helpFor(argv: readonly string[]): string {
  const command = argv.find((item) => !item.startsWith("-") && item !== "help");
  return `usage: ${command !== undefined && COMMAND_USAGE[command] !== undefined ? COMMAND_USAGE[command] : TOP_USAGE}`;
}
