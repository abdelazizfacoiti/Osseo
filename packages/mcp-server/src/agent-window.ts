import type { OsseoMcpContext } from "./context.js";

const BROWSER_APP = /chrom|msedge/i;

/**
 * Whether a desktop window shows the agent's own browser page. A matching title is not enough: the person's
 * browser can show the same page. The window must also belong to the agent browser's process. Without both
 * process ids, only a Chromium-family (or unnamed) window is accepted.
 */
export async function isAgentBrowserWindow(
  context: OsseoMcpContext,
  window: { title?: string | undefined; app?: string | undefined; pid?: number | undefined },
  page: { title: string }
): Promise<boolean> {
  if (page.title.trim().length === 0 || !(window.title ?? "").includes(page.title)) return false;
  const browserPid = await context.linux.browser?.processId?.().catch(() => undefined);
  if (browserPid !== undefined && window.pid !== undefined) return window.pid === browserPid;
  const app = window.app ?? "";
  return app.length === 0 || BROWSER_APP.test(app);
}
