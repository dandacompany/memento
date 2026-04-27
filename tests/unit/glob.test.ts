import { describe, expect, test } from "vitest";

import { matchGlob } from "../../src/core/glob.js";

describe("matchGlob", () => {
  test("matches exact paths", () => {
    expect(matchGlob("/repo/AGENTS.md", "/repo/AGENTS.md")).toBe(true);
    expect(matchGlob("/repo/CLAUDE.md", "/repo/AGENTS.md")).toBe(false);
  });

  test("star matches within one path segment", () => {
    expect(matchGlob("/repo/CLAUDE.md", "/repo/*.md")).toBe(true);
    expect(matchGlob("/repo/docs/CLAUDE.md", "/repo/*.md")).toBe(false);
  });

  test("globstar matches nested segments", () => {
    expect(matchGlob("/repo/docs/nested/CLAUDE.md", "/repo/**/*.md")).toBe(
      true,
    );
  });

  test("globstar slash also matches zero nested segments", () => {
    expect(matchGlob("/repo/CLAUDE.md", "/repo/**/*.md")).toBe(true);
  });

  test("question mark matches one character within a segment", () => {
    expect(matchGlob("/repo/rule-a.md", "/repo/rule-?.md")).toBe(true);
    expect(matchGlob("/repo/rule-ab.md", "/repo/rule-?.md")).toBe(false);
  });

  test("basename patterns match by basename", () => {
    expect(matchGlob("/repo/.memento/private.md", "private.md")).toBe(true);
  });

  test("normalizes platform separators in input paths", () => {
    expect(matchGlob("\\repo\\CLAUDE.md", "/repo/*.md")).toBe(true);
  });
});
