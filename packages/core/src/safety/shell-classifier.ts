import type { RuntimePolicy, RiskLevel, SafetyDecision, SafetyEvaluationContext } from "../types.js";
import { evaluateApprovalRequirement, isApprovalSatisfied } from "./approval.js";
import { classifyAppSensitivity } from "./app-sensitivity.js";
import { classifyPath, isAgentHostControlPath } from "./path-policy.js";

interface ShellRule {
  id: string;
  pattern: RegExp;
  riskLevel: RiskLevel;
  reason: string;
}

const SHELL_RULES: ShellRule[] = [
  {
    id: "shell.rm_rf",
    pattern: /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
    riskLevel: "high",
    reason: "Recursive forced deletion is dangerous."
  },
  {
    id: "shell.sudo",
    pattern: /(^|\s)sudo(\s|$)/i,
    riskLevel: "blocked",
    reason: "sudo is not allowed."
  },
  {
    id: "shell.dd_if",
    pattern: /(^|\s)dd\s+[^|;&]*\bif=/i,
    riskLevel: "high",
    reason: "dd can overwrite disks or copy sensitive device data."
  },
  {
    id: "shell.mkfs",
    pattern: /(^|\s)mkfs(?:\.[a-z0-9]+)?(\s|$)/i,
    riskLevel: "blocked",
    reason: "Filesystem formatting is destructive."
  },
  {
    id: "shell.chmod_777_root",
    pattern: /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
    riskLevel: "blocked",
    reason: "Changing root permissions recursively is unsafe."
  },
  {
    id: "shell.chown_recursive",
    pattern: /\bchown\s+-R\b/i,
    riskLevel: "high",
    reason: "Recursive ownership changes can damage system or user files."
  },
  {
    id: "shell.curl_pipe_bash",
    pattern: /\bcurl\b[\s\S]*\|[\s\S]*\b(?:bash|sh)\b/i,
    riskLevel: "high",
    reason: "Piping downloaded content into a shell is dangerous."
  },
  {
    id: "shell.wget_pipe_sh",
    pattern: /\bwget\b[\s\S]*\|[\s\S]*\b(?:bash|sh)\b/i,
    riskLevel: "high",
    reason: "Piping downloaded content into a shell is dangerous."
  },
  {
    id: "shell.kill_all",
    pattern: /\bkill\s+-9\s+-1\b/i,
    riskLevel: "blocked",
    reason: "Killing all accessible processes is destructive."
  },
  {
    id: "shell.shell_wrapper",
    pattern: /(^|\s)(?:bash|dash|fish|sh|zsh)\s+-c(\s|$)/i,
    riskLevel: "high",
    reason: "Shell wrapper execution requires approval and output limits."
  },
  {
    id: "shell.metacharacter",
    pattern: /[`$][(]|[;&|<>]/,
    riskLevel: "high",
    reason: "Shell metacharacters require approval; commands run without an implicit shell."
  },
  {
    id: "shell.destructive_file_command",
    pattern: /(^|\s)(?:rm|rmdir|shred|truncate|unlink)(\s|$)/i,
    riskLevel: "high",
    reason: "Destructive file commands require explicit approval and exact target."
  },
  {
    id: "shell.package_or_system_change",
    pattern: /(^|\s)(?:apt|apt-get|dnf|yum|pacman|zypper|snap|flatpak|systemctl|service)\s+(?:install|remove|purge|upgrade|dist-upgrade|update|start|stop|restart|enable|disable)\b/i,
    riskLevel: "high",
    reason: "Package or service changes require explicit approval."
  },
  {
    id: "shell.inline_code",
    pattern: /\b(?:python[0-9.]*|node|perl|ruby|php)(?:\.exe)?\s+(?:-c|-e|--eval|-r)\b/i,
    riskLevel: "high",
    reason: "Inline interpreter code can perform arbitrary local actions and requires explicit approval."
  },
  {
    id: "shell.agenthost_control_bypass",
    pattern: /\b(?:agenthost(?:-cli)?|agenthost-mcp)\b[\s\S]*\b(?:task\s+(?:approve|stop)|confirm|deny|pause|resume|stop|takeover|overlay\s+hide|integrations[\s\S]*--apply)\b/i,
    riskLevel: "blocked",
    reason: "AgentHost operator control commands cannot be run by the agent."
  },
  {
    id: "shell.agenthost_control_path",
    pattern: /\.agenthost[\\/](?:run|logs|setup|tasks[\\/]approvals)(?:[\\/]|\b)|\.agenthost[\\/]config\.json\b/i,
    riskLevel: "blocked",
    reason: "AgentHost control-plane files are operator-only."
  }
];

/**
 * Windows command rules (PowerShell, cmd, and the programs they run). They apply only when the
 * platform is Windows, so the POSIX patterns above stay exact on Linux and macOS.
 */
const WINDOWS_SHELL_RULES: ShellRule[] = [
  {
    id: "shell.win_delete",
    pattern: /(?:^|[\s;&|])(?:del|erase|rd|rmdir|remove-item|ri)(?=\s|$)/i,
    riskLevel: "high",
    reason: "Windows delete commands require explicit approval and an exact target."
  },
  {
    id: "shell.win_disk_boot_or_recovery",
    pattern: /(?:^|[\s;&|])(?:format(?:\.com)?\s+[a-z]:|diskpart|bcdedit|vssadmin|cipher(?:\.exe)?\s+\/w|sfc(?:\.exe)?|dism(?:\.exe)?)(?=\s|$)/i,
    riskLevel: "blocked",
    reason: "Disk, boot, and recovery tools are destructive."
  },
  {
    id: "shell.win_machine_registry_write",
    pattern: /\breg(?:\.exe)?\s+(?:add|delete|import)\b[\s\S]*\bHK(?:LM|EY_LOCAL_MACHINE)\b|\b(?:New|Set|Remove|Clear)-ItemProperty\b[\s\S]*\bHKLM:?/i,
    riskLevel: "blocked",
    reason: "Machine-wide registry writes are operator-only."
  },
  {
    id: "shell.win_registry_change",
    pattern: /\breg(?:\.exe)?\s+(?:add|delete|import|restore|copy|load|unload)\b|\b(?:New|Set|Remove|Clear)-ItemProperty\b/i,
    riskLevel: "high",
    reason: "Registry changes require explicit approval."
  },
  {
    id: "shell.win_account_change",
    pattern: /\bnet(?:\.exe)?\s+(?:user|localgroup|group|accounts)\b|\b(?:New|Set|Remove|Add|Disable|Enable)-Local(?:User|Group|GroupMember)\b/i,
    riskLevel: "blocked",
    reason: "Account changes are operator-only."
  },
  {
    id: "shell.win_service_change",
    pattern: /(?:^|[\s;&|])sc(?:\.exe)?\s+(?:create|delete|config|stop|start|failure)\b|\b(?:Start|Stop|Restart|Set|Remove|New)-Service\b/i,
    riskLevel: "high",
    reason: "Service changes require explicit approval."
  },
  {
    id: "shell.win_scheduled_task",
    pattern: /\bschtasks(?:\.exe)?\s+\/(?:create|change|delete|run)\b|\b(?:Register|Unregister|Enable|Disable|Set)-ScheduledTask\b/i,
    riskLevel: "high",
    reason: "Scheduled task changes require explicit approval."
  },
  {
    id: "shell.win_elevation",
    pattern: /\bStart-Process\b[\s\S]*\bRunAs\b|(?:^|[\s;&|])runas(?:\.exe)?\s/i,
    riskLevel: "blocked",
    reason: "Elevation is not allowed."
  },
  {
    id: "shell.win_execution_policy",
    pattern: /\bSet-ExecutionPolicy\b/i,
    riskLevel: "high",
    reason: "Changing the PowerShell execution policy requires explicit approval."
  },
  {
    id: "shell.win_encoded_command",
    pattern: /(?:^|\s)-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i,
    riskLevel: "high",
    reason: "Encoded PowerShell cannot be reviewed before it runs."
  },
  {
    id: "shell.win_shell_wrapper",
    pattern: /(?:^|[\s\\/])(?:powershell|pwsh|cmd)(?:\.exe)?\s+(?:[^\s]+\s+)*?(?:-command|-c|\/c|\/k|-file|-f)(?=\s|$)/i,
    riskLevel: "high",
    reason: "Shell wrapper execution requires approval and output limits."
  },
  {
    id: "shell.win_download_and_run",
    pattern: /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl(?:\.exe)?|wget|bitsadmin|certutil(?:\.exe)?)\b[\s\S]*(?:\||;|&&)\s*(?:iex|Invoke-Expression|powershell|pwsh|cmd)\b|\b(?:iex|Invoke-Expression)\b[\s\S]*\b(?:DownloadString|DownloadFile|Invoke-WebRequest|iwr|irm)\b/i,
    riskLevel: "blocked",
    reason: "Downloading and running code is blocked."
  },
  {
    id: "shell.win_certutil_download",
    pattern: /\bcertutil(?:\.exe)?\b[\s\S]*-urlcache\b/i,
    riskLevel: "high",
    reason: "certutil downloads require explicit approval."
  },
  {
    id: "shell.win_remote_execution",
    pattern: /\b(?:psexec(?:\.exe)?|wmic(?:\.exe)?|winrm|Enter-PSSession|Invoke-Command|New-PSSession)\b/i,
    riskLevel: "high",
    reason: "Remote execution requires explicit approval."
  }
];

const PATH_FRAGMENT_PATTERN = /(?:~\/[^\s'"|;&]+|\/[A-Za-z0-9._~+/@:-]+)/g;

/** Drive paths (C:\x, C:/x), UNC paths (\\server\share), and %VAR%\x paths in Windows commands. */
const WINDOWS_PATH_FRAGMENT_PATTERN = /(?:[A-Za-z]:[\\/][^\s'"|;&<>]*|\\\\[^\s'"|;&<>]+|%[A-Za-z_][A-Za-z0-9_()]*%[\\/][^\s'"|;&<>]*)/g;

const RISK_ORDER: RiskLevel[] = ["observe", "low", "medium", "high", "blocked"];

function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

export function classifyShellCommand(
  command: string,
  policy: RuntimePolicy,
  context: SafetyEvaluationContext = {}
): SafetyDecision {
  const platform = context.platform ?? process.platform;
  let riskLevel: RiskLevel = "medium";
  const reasons = ["Shell commands can change local state and must be classified before execution."];
  const matchedRules = ["shell.command"];

  if (!policy.allowShell) {
    riskLevel = "blocked";
    reasons.push("Shell is disabled by policy.");
    matchedRules.push("policy.shell.disabled");
  }

  const rules = platform === "win32" ? [...SHELL_RULES, ...WINDOWS_SHELL_RULES] : SHELL_RULES;
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      riskLevel = maxRiskLevel(riskLevel, rule.riskLevel);
      reasons.push(rule.reason);
      matchedRules.push(rule.id);
    }
  }

  // Each path-looking word is checked against the same policy as a file tool call.
  const considerPath = (candidate: string): void => {
    if (isAgentHostControlPath(candidate, context)) {
      riskLevel = "blocked";
      reasons.push(`Command touches AgentHost control-plane path: ${candidate}.`);
      matchedRules.push("shell.agenthost_control_path");
      return;
    }
    const pathDecision = classifyPath(candidate, policy, { ...context, access: "read" });

    if (pathDecision.riskLevel === "blocked") {
      riskLevel = "blocked";
      reasons.push(`Command touches blocked path: ${candidate}.`);
      matchedRules.push(...pathDecision.matchedRules);
    } else if (pathDecision.protectionKind === "credential" || pathDecision.protectionKind === "browser_profile") {
      riskLevel = "blocked";
      reasons.push(`Command touches credential or browser profile path: ${candidate}.`);
      matchedRules.push(...pathDecision.matchedRules);
    } else {
      riskLevel = maxRiskLevel(riskLevel, pathDecision.riskLevel);
      matchedRules.push(...pathDecision.matchedRules);
    }
  };

  for (const match of command.matchAll(PATH_FRAGMENT_PATTERN)) {
    considerPath(match[0]);
  }
  if (platform === "win32") {
    for (const match of command.matchAll(WINDOWS_PATH_FRAGMENT_PATTERN)) {
      considerPath(match[0]);
    }
  }

  const approval = evaluateApprovalRequirement(riskLevel, policy, reasons, false, context.confirmationSatisfied === true);
  const blocked = riskLevel === "blocked" || approval.status === "denied";

  return {
    riskLevel,
    appSensitivity: classifyAppSensitivity({}),
    approval,
    allowed: !blocked && isApprovalSatisfied(approval),
    blocked,
    guideOnly: false,
    grantDecision: {
      matchedGrantIds: [],
      allowedByGrantIds: [],
      deniedByGrantIds: [],
      guideOnlyByGrantIds: [],
      requiresDryRun: false,
      requiresConfirmationToken: false,
      requiresApproval: false,
      requiresExactTarget: false
    },
    reasons,
    matchedRules: [...new Set(matchedRules)]
  };
}
