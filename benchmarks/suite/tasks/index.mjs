/*
 * The 25 tasks of the benchmark suite. Each one is a small local page (this folder), a scripted
 * driver, and a condition the harness checks afterwards on its own.
 *
 *   id            stable name, also used by --tasks
 *   goal          one sentence
 *   fixture       the page the driver opens first
 *   tools         the tool names the driver calls (documentation; the counts come from real calls)
 *   expectRefusal error codes that count as the refusal this task expects (omit when none)
 *   run(t)        the driver. t.open, t.snap, t.must, t.expectRefused, t.approved are in
 *                 scripts/benchmark-suite.mjs. Only calls made through t are counted.
 *   check(page,t) the success condition, on an uncounted snapshot taken after the driver:
 *                 page = { title, text, elements }. It never trusts the driver's own result.
 *
 * Values typed into pages are fixed here. Nothing reads or stores anything outside the page.
 */

const has = (page, text) => page.text.includes(text);
const field = (page, name) => page.elements.find((item) => item.name === name);

export const TASKS = [
  {
    id: "text_fields",
    goal: "Fill the Name and Email fields and save; the page must show both values.",
    fixture: "text_fields.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("text_fields.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Name"), text: "Ada Lovelace" }, { ref: page.ref("Email"), text: "ada@example.com" }] });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "saved: Ada Lovelace | ada@example.com")
  },
  {
    id: "select_value",
    goal: "Choose the country whose value is beta in a select list and save.",
    fixture: "select_value.html",
    tools: ["browser.open", "browser.snapshot", "browser.select", "browser.click"],
    async run(t) {
      await t.open("select_value.html");
      const page = await t.snap();
      await t.must("browser.select", { ref: page.ref("Country"), value: "beta" });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "country: beta")
  },
  {
    id: "select_label",
    goal: "Choose Germany in a select list by its visible label and save.",
    fixture: "select_label.html",
    tools: ["browser.open", "browser.snapshot", "browser.select", "browser.click"],
    async run(t) {
      await t.open("select_label.html");
      const page = await t.snap();
      await t.must("browser.select", { ref: page.ref("Destination"), label: "Germany" });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "destination: Germany")
  },
  {
    id: "checkboxes",
    goal: "Tick Music and Travel but not Cooking, then save.",
    fixture: "checkboxes.html",
    tools: ["browser.open", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("checkboxes.html");
      const page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Music") });
      await t.must("browser.click", { ref: page.ref("Travel") });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "interests: music,travel") && !has(page, "cooking")
  },
  {
    id: "radio",
    goal: "Pick the Express radio button and save.",
    fixture: "radio.html",
    tools: ["browser.open", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("radio.html");
      const page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Express") });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "shipping: express")
  },
  {
    id: "multipage",
    goal: "Complete a three-page flow: a name, then an email, and reach the summary page.",
    fixture: "multipage-1.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill"],
    async run(t) {
      await t.open("multipage-1.html");
      let page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Full name"), text: "Ada Lovelace" }], submitRef: page.ref("Next") });
      page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Email"), text: "ada@example.com" }], submitRef: page.ref("Next") });
    },
    check: (page) => page.title === "Done" && has(page, "summary: Ada Lovelace | ada@example.com")
  },
  {
    id: "upload",
    goal: "Attach report.pdf to a file input; the upload needs a previewed, confirmed token.",
    fixture: "upload.html",
    tools: ["browser.open", "browser.snapshot", "browser.upload (dry run)", "browser.upload (with confirmationToken)"],
    async run(t) {
      const file = await t.makeFile("report.pdf", "%PDF-1.4 benchmark fixture\n");
      await t.open("upload.html");
      const page = await t.snap();
      await t.approved("browser.upload", { ref: page.ref("Report file"), files: [file] });
    },
    check: (page) => has(page, "uploaded: report.pdf")
  },
  {
    id: "disabled_button",
    goal: "Try the disabled Continue button; the click must be refused and the page must not change.",
    fixture: "disabled_button.html",
    expectRefusal: ["element_disabled"],
    tools: ["browser.open", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("disabled_button.html");
      const page = await t.snap();
      await t.expectRefused("browser.click", { ref: page.ref("Continue") }, ["element_disabled"]);
    },
    check: (page, t) => t.refused && field(page, "Continue")?.disabled === true && has(page, "status: idle")
  },
  {
    id: "iframe_field",
    goal: "Fill a field that lives in an iframe and save it there.",
    fixture: "iframe_field.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("iframe_field.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Nickname"), text: "Zed" }] });
      await t.must("browser.click", { ref: page.ref("Save nickname") });
    },
    check: (page) => page.title === "frame saved: Zed"
  },
  {
    id: "table_read",
    goal: "Read the Q2 figure for South from a table and type it into the answer field.",
    fixture: "table_read.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("table_read.html");
      const page = await t.snap();
      // The driver finds the figure in the page text, as an agent would: the word South, then Q1, then Q2.
      const cells = page.text.split(/\s+/);
      const at = cells.indexOf("South");
      if (at < 0 || cells[at + 2] === undefined) throw new Error("the South row is not in the page text");
      await t.must("browser.fill", { fields: [{ ref: page.ref("Q2 for South"), text: cells[at + 2] }] });
      await t.must("browser.click", { ref: page.ref("Check") });
    },
    check: (page) => has(page, "answer accepted")
  },
  {
    id: "search_results",
    goal: "Search for lem, open the lemon result and read its detail.",
    fixture: "search.html",
    tools: ["browser.open", "browser.snapshot", "browser.type", "browser.click"],
    async run(t) {
      await t.open("search.html");
      let page = await t.snap();
      await t.must("browser.type", { ref: page.ref("Query"), text: "lem", clear: true, submit: true });
      page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Open lemon") });
    },
    check: (page) => has(page, "detail: lemon is yellow and sour")
  },
  {
    id: "pagination",
    goal: "Move through three pages of a list and select Zeta on the last one.",
    fixture: "pagination-1.html",
    tools: ["browser.open", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("pagination-1.html");
      let page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Next page") });
      page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Next page") });
      page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Select Zeta") });
    },
    check: (page) => page.title === "Page 3" && has(page, "selected: Zeta")
  },
  {
    id: "inline_confirm",
    goal: "Archive a draft through an inline Are you sure step (no browser dialog).",
    fixture: "inline_confirm.html",
    tools: ["browser.open", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("inline_confirm.html");
      let page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Archive draft") });
      page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Yes, archive it") });
    },
    check: (page) => has(page, "state: archived")
  },
  {
    id: "consequential_click",
    goal: "Click Place order, which needs a previewed, confirmed token, and see the order placed.",
    fixture: "consequential.html",
    tools: ["browser.open", "browser.snapshot", "browser.click (dry run)", "browser.click (with confirmationToken)"],
    async run(t) {
      await t.open("consequential.html");
      const page = await t.snap();
      await t.approved("browser.click", { ref: page.ref("Place order") });
    },
    check: (page) => has(page, "state: order placed")
  },
  {
    id: "password_refused",
    goal: "Try to type into a password field; the fill must be refused and nothing may be typed anywhere.",
    fixture: "password_refused.html",
    expectRefusal: ["sensitive_field"],
    tools: ["browser.open", "browser.snapshot", "browser.fill"],
    async run(t) {
      await t.open("password_refused.html");
      const page = await t.snap();
      await t.expectRefused("browser.fill", { fields: [{ ref: page.ref("Wallet name"), text: "Main" }, { ref: page.ref("Wallet secret"), text: "fixture-secret-1" }] }, ["sensitive_field"]);
    },
    check: (page, t) => t.refused && ["Wallet name", "Wallet secret"].every((name) => (field(page, name)?.value ?? "") === "")
  },
  {
    id: "back_button",
    goal: "Open a details page from Home, go back, and land on Home again.",
    fixture: "back_home.html",
    tools: ["browser.open", "browser.snapshot", "browser.click", "browser.navigate"],
    async run(t) {
      await t.open("back_home.html");
      const page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Open details") });
      await t.must("browser.navigate", { action: "back" });
    },
    check: (page) => page.title === "Home" && has(page, "last visit: details")
  },
  {
    id: "validation_fixed",
    goal: "Submit a bad email, read the validation error, fix the email and save.",
    fixture: "validation.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.snapshot", "browser.fill"],
    async run(t) {
      await t.open("validation.html");
      let page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Email"), text: "not-an-email" }], submitRef: page.ref("Save") });
      page = await t.snap();
      if (!page.text.includes("error: enter a valid email")) throw new Error("the validation error was not shown");
      await t.must("browser.fill", { fields: [{ ref: page.ref("Email"), text: "ada@example.com" }], submitRef: page.ref("Save") });
    },
    check: (page) => has(page, "saved: ada@example.com") && !has(page, "error:")
  },
  {
    id: "long_form",
    goal: "Fill three of thirty fields on a form that scrolls, including the last one, and save.",
    fixture: "long_form.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill"],
    async run(t) {
      await t.open("long_form.html");
      const page = await t.snap();
      await t.must("browser.fill", {
        fields: [{ ref: page.ref("Answer 1"), text: "one" }, { ref: page.ref("Answer 15"), text: "fifteen" }, { ref: page.ref("Answer 30"), text: "thirty" }],
        submitRef: page.ref("Save")
      });
    },
    check: (page) => has(page, "saved: one|fifteen|thirty")
  },
  {
    id: "textarea",
    goal: "Write three lines into a text area and save.",
    fixture: "textarea.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("textarea.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Comment"), text: "line one\nline two\nline three" }] });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "lines: 3 | first: line one")
  },
  {
    id: "tabs",
    goal: "Open the Billing tab to reveal a hidden field, fill it and save.",
    fixture: "tabs.html",
    tools: ["browser.open", "browser.snapshot", "browser.click", "browser.snapshot", "browser.fill"],
    async run(t) {
      await t.open("tabs.html");
      let page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Billing") });
      page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Company"), text: "Acme" }], submitRef: page.ref("Save company") });
    },
    check: (page) => has(page, "company: Acme")
  },
  {
    id: "wait_for_result",
    goal: "Start a slow report and wait for its ready text instead of sleeping.",
    fixture: "dynamic_wait.html",
    tools: ["browser.open", "browser.snapshot", "browser.click", "browser.wait_for"],
    async run(t) {
      await t.open("dynamic_wait.html");
      const page = await t.snap();
      await t.must("browser.click", { ref: page.ref("Load report") });
      await t.must("browser.wait_for", { text: "report ready: 42 rows", timeoutMs: 5000 });
    },
    check: (page) => has(page, "report ready: 42 rows")
  },
  {
    id: "replace_prefilled",
    goal: "Replace a prefilled phone number and save.",
    fixture: "prefilled.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("prefilled.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Phone"), text: "555-0100" }] });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "phone: 555-0100") && !has(page, "000-000")
  },
  {
    id: "stale_ref",
    goal: "Click with a ref from before a reload; it must be refused as stale, then click again with a fresh ref.",
    fixture: "stale_ref.html",
    expectRefusal: ["stale_ref"],
    tools: ["browser.open", "browser.snapshot", "browser.navigate", "browser.click", "browser.snapshot", "browser.click"],
    async run(t) {
      await t.open("stale_ref.html");
      const old = await t.snap();
      await t.must("browser.navigate", { action: "reload" });
      await t.expectRefused("browser.click", { ref: old.ref("Press me") }, ["stale_ref"]);
      const fresh = await t.snap();
      await t.must("browser.click", { ref: fresh.ref("Press me") });
    },
    check: (page, t) => t.refused && has(page, "pressed: yes")
  },
  {
    id: "unicode_text",
    goal: "Type a name with accents and CJK characters and read it back from the page.",
    fixture: "unicode.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click"],
    async run(t) {
      await t.open("unicode.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Name"), text: "Zoë 日本語" }] });
      await t.must("browser.click", { ref: page.ref("Save") });
    },
    check: (page) => has(page, "hello Zoë 日本語 (7 chars)")
  },
  {
    id: "reload_keeps_state",
    goal: "Save a draft note, reload the page, and see the note come back from storage.",
    fixture: "reload_state.html",
    tools: ["browser.open", "browser.snapshot", "browser.fill", "browser.click", "browser.navigate"],
    async run(t) {
      await t.open("reload_state.html");
      const page = await t.snap();
      await t.must("browser.fill", { fields: [{ ref: page.ref("Note"), text: "remember me" }] });
      await t.must("browser.click", { ref: page.ref("Save draft") });
      await t.must("browser.navigate", { action: "reload" });
    },
    check: (page) => has(page, "stored: remember me")
  }
];
