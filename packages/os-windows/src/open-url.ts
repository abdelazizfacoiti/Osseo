import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/*
 * Opens an http(s) or file URL on Windows without a shell. The Linux opener runs `xdg-open`, which does not
 * exist here (the first Windows run failed with "xdg-open is not installed or not on PATH").
 *
 * No browser named: the shell's default handler, through `rundll32 url.dll,FileProtocolHandler`, which opens
 * the URL in the person's default browser and needs no quoting. A browser named: its install path is looked up
 * in the usual folders, and the URL is passed as a single argument (no shell, so no injection).
 */

export interface WindowsUrlOpenResult { opened: boolean; url: string; launcher: string; pid?: number; reason: string }
export interface WindowsUrlOpenOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  spawn?: (command: string, args: string[]) => ChildProcess;
}

const win = path.win32;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Install locations for the browsers the open tool can name. */
export function browserCandidates(browser: string, env: NodeJS.ProcessEnv): string[] {
  const programFiles = envValue(env, "ProgramFiles") ?? "C:\\Program Files";
  const programFilesX86 = envValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
  const localAppData = envValue(env, "LOCALAPPDATA");
  const per = (...parts: string[]) => [win.join(programFiles, ...parts), win.join(programFilesX86, ...parts), ...(localAppData === undefined ? [] : [win.join(localAppData, ...parts)])];
  switch (browser) {
    case "google-chrome":
    case "chromium":
    case "chromium-browser": return per("Google", "Chrome", "Application", "chrome.exe");
    case "microsoft-edge": return per("Microsoft", "Edge", "Application", "msedge.exe");
    case "firefox": return per("Mozilla Firefox", "firefox.exe");
    case "brave-browser": return per("BraveSoftware", "Brave-Browser", "Application", "brave.exe");
    default: return [];
  }
}

export async function openWindowsUrl(input: { url: string; browser?: string }, options: WindowsUrlOpenOptions = {}): Promise<WindowsUrlOpenResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { opened: false, url: input.url, launcher: "none", reason: "URL is not valid." };
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    return { opened: false, url: input.url, launcher: "none", reason: "Only http, https, and file URLs can be opened." };
  }
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const spawn = options.spawn ?? ((command: string, args: string[]) => nodeSpawn(command, args, { detached: true, stdio: "ignore", shell: false, env, windowsHide: false }));

  let command: string;
  let args: string[];
  let launcher: string;
  if (input.browser === undefined) {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", parsed.href];
    launcher = "default browser";
  } else {
    const found = browserCandidates(input.browser, env).find((candidate) => exists(candidate));
    if (found === undefined) {
      return { opened: false, url: parsed.href, launcher: input.browser, reason: `${input.browser} was not found in its usual install folders. Open the URL without naming a browser to use the default one.` };
    }
    command = found;
    args = [input.browser === "firefox" ? "-new-tab" : "--new-tab", parsed.href];
    launcher = input.browser;
  }

  const child = spawn(command, args);
  const spawnError = await new Promise<Error | undefined>((resolve) => {
    child.once("error", (error) => resolve(error));
    child.once("spawn", () => resolve(undefined));
  });
  if (spawnError !== undefined) return { opened: false, url: parsed.href, launcher, reason: spawnError.message };
  child.unref();
  return {
    opened: true,
    url: parsed.href,
    launcher,
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    reason: input.browser === undefined ? "Opened with the Windows default handler." : `Opened in a new ${input.browser} tab.`
  };
}
