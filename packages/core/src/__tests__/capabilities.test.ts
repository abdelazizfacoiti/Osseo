import { describe, expect, it } from "vitest";
import { AUTOMATION_STRATEGIES, CapabilityRegistry, createBaseCapabilityRegistry } from "../index.js";

describe("CapabilityRegistry", () => {
  it("lists strategies in the required product order", () => {
    const registry = new CapabilityRegistry();

    expect(registry.listStrategies()).toEqual([...AUTOMATION_STRATEGIES]);
  });

  it("starts empty: the server lists only the tools it really loads", () => {
    expect(createBaseCapabilityRegistry().listTools()).toEqual([]);
  });

  it("rejects duplicate tool registrations", () => {
    const registry = new CapabilityRegistry();

    registry.registerTool({
      name: "system.get_info",
      riskLevel: "observe",
      description: "Example",
      execution: {
        executionClass: "read_only",
        externalEffect: false,
        requiresDryRun: false,
        requiresConfirmationToken: false,
        requiresExactTarget: false,
        source: "base",
        availability: "available"
      }
    });

    expect(() =>
      registry.registerTool({
        name: "system.get_info",
        riskLevel: "observe",
        description: "Duplicate",
        execution: {
          executionClass: "read_only",
          externalEffect: false,
          requiresDryRun: false,
          requiresConfirmationToken: false,
          requiresExactTarget: false,
          source: "base",
          availability: "available"
        }
      })
    ).toThrow(/already registered/);
  });

  it("rejects missing execution metadata outside the explicit bootstrap catalog", () => {
    const registry = new CapabilityRegistry();
    expect(() => registry.registerTool({
      name: "system.get_info",
      riskLevel: "observe",
      description: "Missing metadata"
    })).toThrow(/Missing execution metadata/);
  });

  it("keeps the loaded set unchanged when sync metadata validation fails", () => {
    const registry = new CapabilityRegistry();
    const execution = {
      executionClass: "read_only" as const,
      externalEffect: false,
      requiresDryRun: false,
      requiresConfirmationToken: false,
      requiresExactTarget: false,
      source: "base" as const,
      availability: "available" as const
    };
    registry.registerTool({ name: "system.get_info", riskLevel: "observe", description: "Existing", execution });
    expect(() => registry.syncTools([
      { name: "system.list_capabilities", riskLevel: "observe", description: "Valid", execution },
      { name: "system.bad", riskLevel: "observe", description: "Invalid" }
    ])).toThrow(/Missing execution metadata/);
    expect(registry.listTools().map((tool) => tool.name)).toEqual(["system.get_info"]);
  });
});
