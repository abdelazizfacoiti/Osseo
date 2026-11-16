/**
 * Removes a leading UTF-8 byte-order mark. Windows PowerShell 5.1 writes one with `Set-Content -Encoding utf8`
 * and Notepad can too; JSON.parse and the policy parser reject it, which used to stop the server at start-up.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
