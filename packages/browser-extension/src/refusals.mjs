// Field refusal predicate. The content script carries a copy of the block between the markers
// (content scripts are classic scripts and cannot import); a test compares both copies.

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

export { fieldRefusal };
