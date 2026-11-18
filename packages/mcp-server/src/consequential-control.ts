/**
 * Control names that mean an outside effect: sending, paying, deleting, publishing and the like. A click on a control
 * with such a name asks first, in the agent's browser (browser.click) and in any desktop app (desktop.click, including
 * numbered clicks, whose name comes from see). The name only adds a prompt; it never changes where the click goes.
 */
export const CONSEQUENTIAL_LABEL = /\b(pay|buy|purchase|order|checkout|check out|send|post|publish|tweet|delete|remove|erase|confirm|submit|subscribe|unsubscribe|transfer|withdraw|donate|book|reserve|apply|sign out|log ?out|deactivate|cancel (?:my|the) )\b/i;

export function looksConsequential(name: string | undefined): boolean {
  return name !== undefined && CONSEQUENTIAL_LABEL.test(name);
}
