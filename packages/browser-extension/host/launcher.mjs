// The launcher script Chrome starts as the native host. Chrome gives native hosts a minimal PATH, so the script names
// the node binary and the host file by absolute path instead of relying on a shebang and PATH.

/** Single-quote one value for sh: a single quote becomes '\'' . */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function launcherScript(nodePath, hostPath) {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(hostPath)}\n`;
}
