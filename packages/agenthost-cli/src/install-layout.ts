import path from "node:path";

/*
 * Where an installed release lives, per platform. Pure: platform, home, and
 * environment are arguments so the Windows layout can be tested anywhere.
 *
 *   linux   ~/.local/share/agenthost/{releases/<v>, current, current.previous}   launcher ~/.local/bin/agenthost
 *   win32   %LOCALAPPDATA%\AgentHost\{releases\<v>, current, current.previous}   launcher %LOCALAPPDATA%\AgentHost\bin\agenthost.cmd
 *
 * On Windows `current` and `current.previous` are junctions to a folder under
 * `releases`. A junction can be replaced while programs run from the old
 * release; renaming a folder that has open files fails on Windows.
 */

export interface InstallContext {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export interface InstallLayout {
  platform: NodeJS.Platform;
  root: string;
  releases: string;
  current: string;
  previous: string;
  bin: string;
  /** Files the launcher writes: [`agenthost`] on Linux, [`agenthost.cmd`, `agenthost`] on Windows. */
  launchers: string[];
}

export function installLayout(context: InstallContext): InstallLayout {
  if (context.platform === "win32") {
    const p = path.win32;
    const local = context.env.LOCALAPPDATA !== undefined && context.env.LOCALAPPDATA !== "" ? context.env.LOCALAPPDATA : p.join(context.home, "AppData", "Local");
    const root = p.join(local, "AgentHost");
    const bin = p.join(root, "bin");
    return { platform: "win32", root, releases: p.join(root, "releases"), current: p.join(root, "current"), previous: p.join(root, "current.previous"), bin, launchers: [p.join(bin, "agenthost.cmd"), p.join(bin, "agenthost")] };
  }
  const root = path.join(context.home, ".local", "share", "agenthost");
  const bin = path.join(context.home, ".local", "bin");
  return { platform: context.platform, root, releases: path.join(root, "releases"), current: path.join(root, "current"), previous: path.join(root, "current.previous"), bin, launchers: [path.join(bin, "agenthost")] };
}

/** The `agenthost.cmd` text. Paths use environment variables so a moved profile keeps working. */
export function windowsCmdLauncher(): string {
  return [
    "@echo off",
    "rem AgentHost launcher. Written by scripts\\install.ps1.",
    "node \"%LOCALAPPDATA%\\AgentHost\\current\\bin\\agenthost.mjs\" %*",
    ""
  ].join("\r\n");
}

/** The extensionless shell shim for Git Bash (it does not run .cmd files by bare name). Forward slashes only. */
export function windowsShellLauncher(localAppData: string): string {
  const root = localAppData.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (/["$`\n\r]/u.test(root)) throw new Error("launcher_path_unsafe");
  return ["#!/bin/sh", `exec node "${root}/AgentHost/current/bin/agenthost.mjs" "$@"`, ""].join("\n");
}
