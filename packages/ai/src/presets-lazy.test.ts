import { beforeEach, describe, expect, it } from "vitest";
import { getModel, presetModel, resetCatalog } from "./catalog.js";
// Importing the presets module installs the lazy hooks, exactly as any
// consumer of the package index would get them.
import "./presets.js";

describe("extended presets resolve without explicit registration", () => {
  beforeEach(() => {
    resetCatalog();
  });

  it("presetModel builds a spec for an extended preset", () => {
    const spec = presetModel("zai", "glm-4.7");
    expect(spec.id).toBe("zai/glm-4.7");
    expect(spec.model).toBe("glm-4.7");
  });

  it("getModel pulls the extended catalog in on a miss", () => {
    const spec = getModel("zai/glm-4.7");
    expect(spec).toBeDefined();
    expect(spec?.id).toBe("zai/glm-4.7");
  });

  it("still resolves after resetCatalog re-arms the lazy registration", () => {
    expect(getModel("zai/glm-4.6")).toBeDefined();
    resetCatalog();
    expect(getModel("zai/glm-4.6")).toBeDefined();
  });

  it("unknown presets still fail loudly", () => {
    expect(() => presetModel("not-a-preset", "some-model")).toThrow(/Unknown provider preset/);
  });
});
