import { describe, expect, test } from "vitest";

import {
  normalizeBody,
  parseMarkdown,
  serializeMarkdown,
  unnormalizeBody,
} from "../../../../src/adapters/shared/markdown.js";

describe("shared markdown utilities", () => {
  test("round-trips plain markdown without a trailing newline", () => {
    const input = "# Title\n\nBody";
    const parsed = parseMarkdown(input);

    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("round-trips plain markdown with a trailing newline", () => {
    const input = "# Title\n\nBody\n";
    const parsed = parseMarkdown(input);

    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("round-trips YAML frontmatter without normalization loss", () => {
    const input = "---\ntitle: Test\ncount: 1\n---\nBody";
    const parsed = parseMarkdown(input);

    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("round-trips empty frontmatter", () => {
    const input = "---\n---\nBody";
    const parsed = parseMarkdown(input);

    expect(parsed.frontmatter).toEqual({});
    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("normalizes CRLF to LF", () => {
    expect(normalizeBody("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  });

  test("parses CRLF input as LF body and serializes back with CRLF hints", () => {
    const input = "one\r\n\r\ntwo\r\n";
    const parsed = parseMarkdown(input);

    expect(parsed.body).toBe("one\n\ntwo\n");
    expect(parsed.rawHints.hadCRLF).toBe(true);
    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("removes a leading BOM during normalization", () => {
    expect(normalizeBody("\uFEFF# Title")).toBe("# Title");
  });

  test("restores a BOM on serialize when hints captured one", () => {
    const input = "\uFEFF# Title\n";
    const parsed = parseMarkdown(input);

    expect(parsed.body).toBe("# Title\n");
    expect(parsed.rawHints.hadBOM).toBe(true);
    expect(
      serializeMarkdown(parsed.body, parsed.frontmatter, parsed.rawHints),
    ).toBe(input);
  });

  test("trims trailing whitespace on each line", () => {
    expect(normalizeBody("one  \ntwo\t\nthree   ")).toBe("one\ntwo\nthree");
  });

  test("accepts valid surrogate pairs", () => {
    expect(normalizeBody("smile \uD83D\uDE00")).toBe("smile \uD83D\uDE00");
  });

  test("rejects an unpaired high surrogate", () => {
    expect(() => normalizeBody("bad \uD83D")).toThrow(TypeError);
  });

  test("rejects an unpaired low surrogate", () => {
    expect(() => normalizeBody("bad \uDE00")).toThrow(TypeError);
  });

  test("separates frontmatter from the body", () => {
    const parsed = parseMarkdown(
      "---\ntitle: Test\ntags:\n  - sync\n---\nBody",
    );

    expect(parsed.body).toBe("Body");
    expect(parsed.frontmatter).toEqual({
      title: "Test",
      tags: ["sync"],
    });
  });

  test("returns null frontmatter when no frontmatter exists", () => {
    const parsed = parseMarkdown("Body only");

    expect(parsed.body).toBe("Body only");
    expect(parsed.frontmatter).toBeNull();
  });

  test("serializes missing frontmatter without delimiters", () => {
    expect(serializeMarkdown("Body", null)).toBe("Body");
  });

  test("serializes empty frontmatter with empty delimiters", () => {
    expect(serializeMarkdown("Body", {})).toBe("---\n---\nBody");
  });

  test("does not compact blank lines by default", () => {
    expect(normalizeBody("one\n\n\ntwo")).toBe("one\n\n\ntwo");
  });

  test("compacts three or more consecutive line breaks when requested", () => {
    expect(
      normalizeBody("one\n\n\ntwo\n\n\n\nthree", {
        compactBlankLines: true,
      }),
    ).toBe("one\n\ntwo\n\nthree");
  });

  test("unnormalizes body with CRLF, BOM, and trailing newline hints", () => {
    expect(
      unnormalizeBody("one\ntwo", {
        hadBOM: true,
        hadCRLF: true,
        trailingNewline: true,
      }),
    ).toBe("\uFEFFone\r\ntwo\r\n");
  });
});
