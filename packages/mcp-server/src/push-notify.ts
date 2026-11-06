/*
 * Optional phone notification: one generic POST to a URL the operator chose
 * (for example a private ntfy.sh topic). It says only that AgentHost is waiting.
 * It carries no preview, app name, task text, or token, because that URL belongs
 * to a third party. It cannot approve anything: approval stays at the computer,
 * behind the real-pointer check, and AgentHost opens no listener.
 */

const MIN_INTERVAL_MS = 30_000;

export const PUSH_MESSAGES = {
  approval: "AgentHost is waiting for your approval at the computer.",
  handoff: "AgentHost needs you at the computer."
} as const;

export function isValidPushUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

export function createPushNotifier(pushUrl: string | undefined, options: { fetchImpl?: typeof fetch; now?: () => number } = {}): (kind: keyof typeof PUSH_MESSAGES) => Promise<boolean> {
  const send = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let lastAt = -Infinity;
  return async (kind) => {
    if (pushUrl === undefined || !isValidPushUrl(pushUrl)) return false;
    if (now() - lastAt < MIN_INTERVAL_MS) return false;
    lastAt = now();
    try {
      const response = await send(pushUrl, { method: "POST", body: PUSH_MESSAGES[kind], headers: { "content-type": "text/plain" }, signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false; // Best effort: a failed notification never affects the run.
    }
  };
}
