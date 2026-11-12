import os from "node:os";
import path from "node:path";
import type {
  PathAccessMode,
  PathSafetyResult,
  RuntimePolicy,
  RiskLevel,
  SafetyEvaluationContext
} from "../types.js";

type PathApi = typeof path.posix;

/**
 * Windows paths use path.win32: drive letters, backslashes, and case-insensitive comparison.
 * Everything else uses POSIX paths. Passing `platform` in the context lets tests evaluate Windows
 * rules on any host.
 */
function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

const POSIX_SYSTEM_ROOTS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var"];

const POSIX_CREDENTIAL_ROOT_TEMPLATES = ["~/.ssh", "~/.gnupg", "~/.local/share/keyrings"];

const POSIX_BROWSER_PROFILE_ROOT_TEMPLATES = [
  "~/.mozilla",
  "~/.config/google-chrome",
  "~/.config/chromium",
  "~/.config/BraveSoftware",
  "~/.config/microsoft-edge",
  "~/.config/opera",
  "~/.config/vivaldi",
  "~/snap/firefox/common/.mozilla",
  "~/Library/Application Support/Firefox",
  "~/Library/Application Support/Google/Chrome"
];

// Windows templates: "~" is the user's home folder, and %NAME% is read from the environment.
const WINDOWS_SYSTEM_ROOT_TEMPLATES = ["%SystemRoot%", "%ProgramFiles%", "%ProgramFiles(x86)%", "%ProgramData%"];

const WINDOWS_CREDENTIAL_ROOT_TEMPLATES = [
  "~\\.ssh",
  "~\\.gnupg",
  "~\\.aws",
  "~\\.docker",
  "%APPDATA%\\Microsoft\\Credentials",
  "%LOCALAPPDATA%\\Microsoft\\Credentials",
  "%APPDATA%\\Microsoft\\Protect",
  "%LOCALAPPDATA%\\Microsoft\\Protect",
  "%LOCALAPPDATA%\\Microsoft\\Vault"
];

const WINDOWS_BROWSER_PROFILE_ROOT_TEMPLATES = [
  "%LOCALAPPDATA%\\Google\\Chrome\\User Data",
  "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data",
  "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data",
  "%APPDATA%\\Mozilla\\Firefox",
  "%APPDATA%\\Opera Software"
];

/** Used when the environment has no value for a Windows system folder. */
const WINDOWS_FOLDER_DEFAULTS: Record<string, string> = {
  SYSTEMROOT: "C:\\Windows",
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  PROGRAMDATA: "C:\\ProgramData"
};

function environmentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && value !== undefined && value !== "") return value;
  }
  return undefined;
}

function expandEnvironment(input: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform !== "win32") return input;
  return input.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole: string, name: string) => {
    return environmentValue(env, name) ?? WINDOWS_FOLDER_DEFAULTS[name.toUpperCase()] ?? whole;
  });
}

function expandHome(input: string, homeDir: string, platform: NodeJS.Platform): string {
  if (input === "~") {
    return homeDir;
  }
  const prefixes = platform === "win32" ? ["~/", "~\\"] : ["~/"];
  for (const prefix of prefixes) {
    if (input.startsWith(prefix)) {
      return pathApi(platform).join(homeDir, input.slice(prefix.length));
    }
  }
  return input;
}

export function normalizePathForPolicy(inputPath: string, context: SafetyEvaluationContext = {}): string {
  const platform = context.platform ?? process.platform;
  const homeDir = context.homeDir ?? os.homedir();
  const cwd = context.cwd ?? process.cwd();
  const expanded = expandHome(expandEnvironment(inputPath, platform, context.env ?? process.env), homeDir, platform);
  return pathApi(platform).resolve(cwd, expanded);
}

function isInsideOrEqual(candidate: string, root: string, api: PathApi): boolean {
  const relative = api.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolveAllowedWriteRoots(
  policy: RuntimePolicy,
  context: SafetyEvaluationContext = {}
): string[] {
  const roots = policy.allowFileWriteRoots.map((root) => normalizePathForPolicy(root, context));

  if (context.agentHostDir !== undefined) {
    roots.push(normalizePathForPolicy(context.agentHostDir, context));
  }

  return unique(roots);
}

function controlPlaneRoots(agentHostDir: string | undefined, protectedPaths: string[] | undefined, api: PathApi): string[] {
  const roots = [
    ...(agentHostDir === undefined
      ? []
      : [
          api.join(agentHostDir, "run"),
          api.join(agentHostDir, "tasks", "approvals"),
          api.join(agentHostDir, "logs"),
          api.join(agentHostDir, "setup"),
          api.join(agentHostDir, "config.json"),
          api.join(agentHostDir, "policy.toml")
        ]),
    ...(protectedPaths ?? [])
  ];
  return unique(roots.map((root) => api.resolve(root)));
}

export function isAgentHostControlPath(inputPath: string, context: SafetyEvaluationContext = {}): boolean {
  const api = pathApi(context.platform ?? process.platform);
  const normalized = normalizePathForPolicy(inputPath, context);
  return controlPlaneRoots(context.agentHostDir, context.protectedPaths, api).some((root) => isInsideOrEqual(normalized, root, api));
}

function protectionForPath(
  normalizedPath: string,
  context: SafetyEvaluationContext & { homeDir: string },
  protectedPaths: string[] | undefined
): PathSafetyResult["protectionKind"] {
  const platform = context.platform ?? process.platform;
  const api = pathApi(platform);
  const homeDir = context.homeDir;

  if (normalizedPath === api.parse(normalizedPath).root) {
    return "root";
  }

  if (controlPlaneRoots(context.agentHostDir, protectedPaths, api).some((root) => isInsideOrEqual(normalizedPath, root, api))) {
    return "agenthost_control";
  }

  const rootsFrom = (templates: string[]): string[] => templates.map((template) => normalizePathForPolicy(template, { ...context, platform, homeDir }));

  const credentialTemplates = platform === "win32" ? WINDOWS_CREDENTIAL_ROOT_TEMPLATES : POSIX_CREDENTIAL_ROOT_TEMPLATES;
  if (rootsFrom(credentialTemplates).some((root) => isInsideOrEqual(normalizedPath, root, api))) {
    return "credential";
  }

  const browserTemplates = platform === "win32" ? WINDOWS_BROWSER_PROFILE_ROOT_TEMPLATES : POSIX_BROWSER_PROFILE_ROOT_TEMPLATES;
  if (rootsFrom(browserTemplates).some((root) => isInsideOrEqual(normalizedPath, root, api))) {
    return "browser_profile";
  }

  const systemRoots = platform === "win32" ? rootsFrom(WINDOWS_SYSTEM_ROOT_TEMPLATES) : POSIX_SYSTEM_ROOTS;
  if (systemRoots.some((root) => isInsideOrEqual(normalizedPath, root, api))) {
    return "system";
  }

  if (isInsideOrEqual(normalizedPath, api.resolve(homeDir), api)) {
    return "home";
  }

  return "none";
}

function pathRisk(
  access: PathAccessMode,
  protectionKind: PathSafetyResult["protectionKind"],
  isAllowedWriteRoot: boolean
): RiskLevel {
  if (protectionKind === "root" || protectionKind === "credential" || protectionKind === "browser_profile") {
    return "blocked";
  }

  if (protectionKind === "agenthost_control") {
    return access === "read" ? "medium" : "blocked";
  }

  if (protectionKind === "system") {
    return access === "read" ? "high" : "blocked";
  }

  if (access === "delete") {
    return (protectionKind === "none" || protectionKind === "home") && isAllowedWriteRoot ? "high" : "blocked";
  }

  if (access === "write") {
    return isAllowedWriteRoot ? "medium" : "high";
  }

  if (protectionKind === "home" && isAllowedWriteRoot) {
    return "low";
  }

  return protectionKind === "none" ? "low" : "high";
}

export function classifyPath(
  inputPath: string,
  policy: RuntimePolicy,
  context: SafetyEvaluationContext & { access?: PathAccessMode } = {}
): PathSafetyResult {
  const platform = context.platform ?? process.platform;
  const api = pathApi(platform);
  const homeDir = context.homeDir ?? os.homedir();
  const access = context.access ?? "read";
  const scoped = { ...context, platform, homeDir };
  const normalizedPath = normalizePathForPolicy(inputPath, scoped);
  const allowedWriteRoots = resolveAllowedWriteRoots(policy, scoped);
  const isAllowedWriteRoot = allowedWriteRoots.some((root) => isInsideOrEqual(normalizedPath, root, api));
  const protectionKind = protectionForPath(normalizedPath, scoped, context.protectedPaths);
  const riskLevel = pathRisk(access, protectionKind, isAllowedWriteRoot);
  const reasons: string[] = [];
  const matchedRules: string[] = [];

  if (protectionKind !== "none") {
    reasons.push(`Path is protected as ${protectionKind}.`);
    matchedRules.push(`path.protected.${protectionKind}`);
  }

  if (platform === "win32" && (inputPath.startsWith("\\\\") || inputPath.startsWith("//"))) {
    reasons.push("Network (UNC) path: its contents are not covered by local protections.");
    matchedRules.push("path.network");
  }

  if (access === "write" && isAllowedWriteRoot) {
    reasons.push("Path is inside an allowed write root.");
    matchedRules.push("path.write.allowed_root");
  }

  if (access === "write" && !isAllowedWriteRoot) {
    reasons.push("Path is outside allowed write roots.");
    matchedRules.push("path.write.outside_allowed_roots");
  }

  if (access === "delete") {
    reasons.push("Deleting files is high-risk by default.");
    matchedRules.push("path.delete");
  }

  return {
    inputPath,
    normalizedPath,
    access,
    isProtectedPath: protectionKind !== "none",
    protectionKind,
    isAllowedWriteRoot,
    allowedWriteRoots,
    riskLevel,
    reasons,
    matchedRules
  };
}
