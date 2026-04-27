import { describe, expect, test } from "vitest";

import { colorizedUnifiedDiff } from "../../../src/prompts/diff.js";

function stripAnsi(input: string): string {
  return input.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
    "",
  );
}

describe("colorizedUnifiedDiff", () => {
  test("shows no changes for identical content", () => {
    const diff = stripAnsi(colorizedUnifiedDiff("same", "same", "A", "B"));

    expect(diff).toContain("--- A");
    expect(diff).toContain("+++ B");
    expect(diff).toContain(" no changes");
    expect(diff).not.toContain("-same");
    expect(diff).not.toContain("+same");
  });

  test("shows a single-line replacement", () => {
    const diff = stripAnsi(colorizedUnifiedDiff("old", "new", "A", "B"));

    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
  });

  test("keeps shared lines as context in multi-line content", () => {
    const diff = stripAnsi(
      colorizedUnifiedDiff("one\ntwo\nthree", "one\nTWO\nthree", "A", "B"),
    );

    expect(diff).toContain(" one");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    expect(diff).toContain(" three");
  });

  test("handles added lines", () => {
    const diff = stripAnsi(
      colorizedUnifiedDiff("one\nthree", "one\ntwo\nthree", "A", "B"),
    );

    expect(diff).toContain(" one");
    expect(diff).toContain("+two");
    expect(diff).toContain(" three");
  });

  test("handles removed lines", () => {
    const diff = stripAnsi(
      colorizedUnifiedDiff("one\ntwo\nthree", "one\nthree", "A", "B"),
    );

    expect(diff).toContain(" one");
    expect(diff).toContain("-two");
    expect(diff).toContain(" three");
  });

  test("handles completely different multi-line content", () => {
    const diff = stripAnsi(
      colorizedUnifiedDiff("alpha\nbeta", "gamma\ndelta", "A", "B"),
    );

    expect(diff).toContain("-alpha");
    expect(diff).toContain("-beta");
    expect(diff).toContain("+gamma");
    expect(diff).toContain("+delta");
  });
});
