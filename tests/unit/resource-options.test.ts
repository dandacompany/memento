import { describe, expect, test } from "vitest";

import {
  parseResourceKinds,
  parseResourceScope,
} from "../../src/core/resource-options.js";
import { MementoError } from "../../src/core/errors.js";

describe("resource options", () => {
  test("parseResourceKinds defaults to all resources", () => {
    expect(parseResourceKinds()).toEqual(["memory", "skill", "mcp"]);
  });

  test("parseResourceKinds accepts singular and plural aliases", () => {
    expect(parseResourceKinds({ resources: "memories,skills,mcps" })).toEqual([
      "memory",
      "skill",
      "mcp",
    ]);
  });

  test("parseResourceKinds trims whitespace and dedupes", () => {
    expect(parseResourceKinds({ resources: " memory, skill,skills " })).toEqual(
      ["memory", "skill"],
    );
  });

  test("parseResourceKinds applies negative flags", () => {
    expect(parseResourceKinds({ noMcp: true, noSkills: true })).toEqual([
      "memory",
    ]);
  });

  test("parseResourceKinds applies negative flags to explicit selection", () => {
    expect(
      parseResourceKinds({ resources: "skills,mcp", noMcp: true }),
    ).toEqual(["skill"]);
  });

  test("parseResourceKinds rejects unknown resources", () => {
    expect(() => parseResourceKinds({ resources: "hooks" })).toThrow(
      MementoError,
    );
  });

  test("parseResourceKinds rejects an empty explicit list", () => {
    expect(() => parseResourceKinds({ resources: " , " })).toThrow(
      MementoError,
    );
  });

  test.each(["local", "project", "cross-cli"] as const)(
    "parseResourceScope accepts %s",
    (scope) => {
      expect(parseResourceScope(scope)).toBe(scope);
    },
  );

  test("parseResourceScope defaults to local", () => {
    expect(parseResourceScope()).toBe("local");
  });

  test("parseResourceScope rejects unknown scope", () => {
    expect(() => parseResourceScope("team")).toThrow(MementoError);
  });
});
