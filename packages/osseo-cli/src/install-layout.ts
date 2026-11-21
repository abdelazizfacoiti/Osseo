import path from "node:path";

/*
 * Where an installed release lives, per platform. Pure: platform, home, and
 * environment are arguments so the Windows layout can be tested anywhere.
 *
 *   linux   ~/.local/share/osseo/{releases/<v>, current, current.previous}   launcher ~/.local/bin/osseo
 *   win32   %LOCALAPPDATA%\Osseo\{releases\<v>, current, current.previous}   launcher %LOCALAPPDATA%\Osseo\bin\osseo.cmd
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
  /** Files the launcher writes: [`osseo`] on Linux, [`osseo.cmd`, `osseo`] on Windows. */
  launchers: string[];
}

export function installLayout(context: InstallContext): InstallLayout {
  if (context.platform === "win32") {
    const p = path.win32;
    const local = context.env.LOCALAPPDATA !== undefined && context.env.LOCALAPPDATA !== "" ? context.env.LOCALAPPDATA : p.join(context.home, "AppData", "Local");
    const root = p.join(local, "Osseo");
    const bin = p.join(root, "bin");
    return { platform: "win32", root, releases: p.join(root, "releases"), current: p.join(root, "current"), previous: p.join(root, "current.previous"), bin, launchers: [p.join(bin, "osseo.cmd"), p.join(bin, "osseo")] };
  }
  const root = path.join(context.home, ".local", "share", "osseo");
  const bin = path.join(context.home, ".local", "bin");
  return { platform: context.platform, root, releases: path.join(root, "releases"), current: path.join(root, "current"), previous: path.join(root, "current.previous"), bin, launchers: [path.join(bin, "osseo")] };
}

/** The `osseo.cmd` text. Paths use environment variables so a moved profile keeps working. */
export function windowsCmdLauncher(): string {
  return [
    "@echo off",
    "rem Osseo launcher. Written by scripts\\install.ps1.",
    "node \"%LOCALAPPDATA%\\Osseo\\current\\bin\\osseo.mjs\" %*",
    ""
  ].join("\r\n");
}

/** The extensionless shell shim for Git Bash (it does not run .cmd files by bare name). Forward slashes only. */
export function windowsShellLauncher(localAppData: string): string {
  const root = localAppData.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (/["$`\n\r]/u.test(root)) throw new Error("launcher_path_unsafe");
  return ["#!/bin/sh", `exec node "${root}/Osseo/current/bin/osseo.mjs" "$@"`, ""].join("\n");
}
