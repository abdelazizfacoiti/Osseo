// Osseo content script. Builds the element list and performs actions in the page.
// It never reads or sends cookies, browser-side storage or credentials, and refuses sensitive
// fields before any typing. Page content leaves only as the reply to the background script.
(() => {
  if (window.__osseoContent) return;
  window.__osseoContent = true;

  // BEGIN refusals
  const REFUSED_AUTOCOMPLETE = /^(one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?|cc-name|cc-type|current-password|new-password)$/;
  // Deliberately broad: "tokenizer", "classname" (ssn) and "discard" (card) are refused too. A false refusal costs a
  // manual step; a false allow could leak a secret.
  const REFUSED_NAME = /password|passcode|otp|token|secret|card|cvv|cvc|iban|ssn/i;
  function fieldRefusal(field) {
    const tag = String(field.tag || "").toLowerCase();
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;
    const type = String(field.type || "").toLowerCase();
    if (type === "password") return "password_field";
    const tokens = String(field.autocomplete || "").toLowerCase().split(/\s+/);
    if (tokens.some((token) => REFUSED_AUTOCOMPLETE.test(token))) return "sensitive_autocomplete";
    if (REFUSED_NAME.test(String(field.name || "")) || REFUSED_NAME.test(String(field.id || ""))) return "sensitive_name";
    return null;
  }
  // END refusals

  const SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"]';
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);

  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type") || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    name: el.getAttribute("name") || "",
    id: el.id || ""
  });

  function snapshot(max) {
    const found = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
      if (el.tagName === "INPUT" && el.type === "hidden") continue;
      found.push(el);
    }
    const snap = (window.__ahSnap || 0) + 1;
    window.__ahSnap = snap;
    window.__ahRefs = found;
    const elements = found.slice(0, max).map((el, i) => {
      const d = describe(el);
      const refusal = fieldRefusal(d);
      const name = clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || d.name);
      const role = el.getAttribute("role") || (d.tag === "a" ? "link" : d.tag === "select" ? "combobox" : d.tag === "textarea" ? "textbox" : d.tag === "input" ? (d.type === "checkbox" ? "checkbox" : d.type === "radio" ? "radio" : d.type === "submit" || d.type === "button" ? "button" : "textbox") : d.tag);
      const item = { ref: "s" + snap + "-e" + i, role, name, enabled: !el.disabled };
      if (refusal) {
        item.refused = refusal;
      } else if (d.tag === "input" && d.type !== "checkbox" && d.type !== "radio" && d.type !== "file" && el.value) {
        item.value = clean(el.value).slice(0, 40);
      } else if ((d.tag === "textarea" || d.tag === "select") && el.value) {
        item.value = clean(el.value).slice(0, 40);
      }
      if (d.tag === "input" && (d.type === "checkbox" || d.type === "radio")) item.checked = !!el.checked;
      return item;
    });
    return { ok: true, title: document.title, elements, truncated: found.length > max };
  }

  function resolve(ref) {
    const m = /^s(\d+)-e(\d+)$/.exec(String(ref));
    if (!m || Number(m[1]) !== window.__ahSnap || !window.__ahRefs) return null;
    const el = window.__ahRefs[Number(m[2])];
    return el && el.isConnected ? el : null;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function act(msg) {
    const el = resolve(msg.ref);
    if (!el) return { ok: false, reason: "ref_stale" };
    const refusal = fieldRefusal(describe(el));
    if (refusal) return { ok: false, reason: refusal };
    if (el.disabled) return { ok: false, reason: "disabled" };
    if (msg.type === "click") {
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true };
    }
    if (msg.type === "type") {
      if (el.isContentEditable) {
        el.focus();
        el.textContent = msg.text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.focus();
        setNativeValue(el, msg.text);
      } else {
        return { ok: false, reason: "not_typeable" };
      }
      return { ok: true, value: clean(el.value || el.textContent).slice(0, 40) };
    }
    if (msg.type === "select") {
      if (el.tagName !== "SELECT") return { ok: false, reason: "not_select" };
      const option = Array.from(el.options).find((o) => o.value === msg.value || o.text.trim() === msg.value);
      if (!option) return { ok: false, reason: "option_not_found" };
      setNativeValue(el, option.value);
      return { ok: true, value: clean(option.text) };
    }
    return { ok: false, reason: "unknown_type" };
  }

  function read() {
    const text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
    return { ok: true, title: document.title, text: text.slice(0, 20000), truncated: text.length > 20000 };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.osseo !== true) return;
    try {
      if (msg.type === "snapshot") sendResponse(snapshot(Math.min(Number(msg.max) || 120, 300)));
      else if (msg.type === "read") sendResponse(read());
      else sendResponse(act(msg));
    } catch (error) {
      sendResponse({ ok: false, reason: "content_error" });
    }
  });
})();
