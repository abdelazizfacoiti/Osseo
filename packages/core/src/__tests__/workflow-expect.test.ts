import { describe, expect, it } from "vitest";
import { validateExpectation, WorkflowError } from "../saved-workflows.js";

describe("validateExpectation", () => {
  it("accepts absent expectations and any non-empty combination of the three checks", () => {
    expect(() => validateExpectation(undefined, 0)).not.toThrow();
    expect(() => validateExpectation({ screenChanged: true }, 0)).not.toThrow();
    expect(() => validateExpectation({ windowTitle: "Editor", textVisible: "Saved" }, 0)).not.toThrow();
  });

  it("refuses unknown keys and an empty expectation", () => {
    expect(() => validateExpectation({}, 0)).toThrow(WorkflowError);
    expect(() => validateExpectation({ urlContains: "x" } as never, 0)).toThrow(WorkflowError);
  });

  it("refuses a non-boolean screenChanged and over-long text", () => {
    expect(() => validateExpectation({ screenChanged: "yes" } as never, 2)).toThrow(/Step 3: screenChanged/);
    expect(() => validateExpectation({ textVisible: "x".repeat(201) }, 0)).toThrow(/textVisible is 1-200/);
    expect(() => validateExpectation({ windowTitle: "   " }, 0)).toThrow(/windowTitle is 1-200/);
  });
});
