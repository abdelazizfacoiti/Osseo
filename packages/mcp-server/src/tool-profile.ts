import type { AnyOsseoToolDefinition } from "./tool-runner.js";

/** The tools listed by default (profile "desktop"). Every other tool stays callable but is not listed. */
export const DEFAULT_TOOL_NAMES = [
  "see", "click", "type", "key", "scroll", "drag", "open", "windows", "wait", "ask", "steps", "status", "guide.show", "guide.clear"
] as const;

const DEFAULT_SET = new Set<string>(DEFAULT_TOOL_NAMES);

export type ToolProfile = "desktop" | "full";

export function isDefaultTool(name: string): boolean {
  return DEFAULT_SET.has(name);
}

/** The tools tools/list returns for a profile. */
export function listedTools<T extends Pick<AnyOsseoToolDefinition, "name">>(tools: T[], profile: ToolProfile): T[] {
  return profile === "full" ? tools : tools.filter((tool) => DEFAULT_SET.has(tool.name));
}

const REPLACEMENT: Record<string, string> = {
  "desktop.click": "click",
  "desktop.pointer": "click, scroll or drag",
  "desktop.type_text": "type",
  "desktop.set_field": "type",
  "desktop.hotkey": "key",
  "desktop.screenshot": "see",
  "desktop.file_dialog_select": "see, click and type",
  "screen.read": "see",
  "ui.tree": "see",
  "ui.find": "see",
  "ui.activate": "see then click",
  "ui.set_text": "see then type",
  "vision.find_text_on_screen": "see",
  "vision.find_text": "see",
  "vision.find_target": "see",
  "vision.analyze_image": "see",
  "browser.snapshot": "see",
  "browser.screenshot": "see",
  "browser.click": "see then click",
  "browser.type": "see then type",
  "browser.fill": "see then type",
  "browser.open": "open",
  "browser.navigate": "open",
  "browser.wait_for": "wait",
  "app.open": "open",
  "app.open_url": "open",
  "window.list": "windows",
  "window.focus": "windows",
  "computer.wait_for": "wait",
  "computer.wait": "wait",
  "computer.observe_state": "see or windows",
  "computer.run_steps": "steps",
  "agent.request_handoff": "ask",
  "agent.status": "status"
};

/** The one observation added when a hidden tool is called directly in the desktop profile. */
export function hiddenToolHint(name: string): string {
  const replacement = REPLACEMENT[name];
  return replacement === undefined
    ? `${name} is outside the default tool list (profile desktop). It still works; set tools.profile to full to list it.`
    : `${name} still works, but prefer ${replacement}: call see, then act by number.`;
}
