import type { SafetyInput } from "./types.js";

const STATE_CHANGING_ACTIONS: ReadonlySet<SafetyInput["actionType"]> = new Set([
  "app_launch",
  "shell_command",
  "file_write",
  "file_delete",
  "gui_click",
  "gui_type",
  "accessibility_action",
  "accessibility_set_value",
  "accessibility_focus",
  "browser_action",
  "communication_send",
  "upload",
  "system_change",
  "unknown"
]);

export function isStateChangingAction(actionType: SafetyInput["actionType"]): boolean {
  return STATE_CHANGING_ACTIONS.has(actionType);
}
