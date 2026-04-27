import matter from "gray-matter";

export interface ParsedMarkdown {
  body: string;
  frontmatter: Record<string, unknown> | null;
  rawHints: {
    hadCRLF: boolean;
    hadBOM: boolean;
    trailingNewline: boolean;
    originalContent?: string;
    normalizedBody?: string;
    frontmatterJson?: string;
  };
}

export interface NormalizeBodyOptions {
  compactBlankLines?: boolean;
}

export function parseMarkdown(content: string): ParsedMarkdown {
  assertValidUnicodeScalarString(content);

  const parseableContent =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const parsed = matter(parseableContent);
  const parsedWithEmptyHint = parsed as typeof parsed & { isEmpty?: boolean };
  const hasFrontmatter =
    (parsed.matter?.length ?? 0) > 0 || parsedWithEmptyHint.isEmpty === true;
  const body = normalizeBody(parsed.content);
  const frontmatter = hasFrontmatter ? parsed.data : null;
  const rawHints = {
    hadCRLF: content.includes("\r\n"),
    hadBOM: content.charCodeAt(0) === 0xfeff,
    trailingNewline: content.endsWith("\n"),
    originalContent: content,
    normalizedBody: body,
    frontmatterJson: stableJson(frontmatter),
  };

  return {
    body,
    frontmatter,
    rawHints,
  };
}

export function serializeMarkdown(
  body: string,
  frontmatter: Record<string, unknown> | null,
  hints?: ParsedMarkdown["rawHints"],
): string {
  assertValidUnicodeScalarString(body);

  if (
    hints?.originalContent !== undefined &&
    hints.normalizedBody === body &&
    hints.frontmatterJson === stableJson(frontmatter)
  ) {
    return hints.originalContent;
  }

  const serialized =
    frontmatter === null ? body : serializeWithFrontmatter(body, frontmatter);

  return hints === undefined ? serialized : unnormalizeBody(serialized, hints);
}

export function normalizeBody(
  raw: string,
  options: NormalizeBodyOptions = {},
): string {
  assertValidUnicodeScalarString(raw);

  let normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  normalized = normalized.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/[^\S\n]+$/gm, "");

  if (options.compactBlankLines === true) {
    normalized = normalized.replace(/\n{3,}/g, "\n\n");
  }

  return normalized;
}

export function unnormalizeBody(
  body: string,
  hints: ParsedMarkdown["rawHints"],
): string {
  assertValidUnicodeScalarString(body);

  let output = hints.trailingNewline
    ? ensureTrailingLF(body)
    : stripTrailingLFs(body);

  if (hints.hadCRLF) {
    output = output.replace(/\n/g, "\r\n");
  }

  return hints.hadBOM ? `\uFEFF${output}` : output;
}

function serializeWithFrontmatter(
  body: string,
  frontmatter: Record<string, unknown>,
): string {
  const yaml = stringifyFrontmatterYaml(frontmatter);
  const bodySuffix = body.length > 0 ? `\n${body}` : "";

  return yaml.length > 0
    ? `---\n${yaml}\n---${bodySuffix}`
    : `---\n---${bodySuffix}`;
}

function stringifyFrontmatterYaml(
  frontmatter: Record<string, unknown>,
): string {
  if (Object.keys(frontmatter).length === 0) {
    return "";
  }

  const serialized = matter.stringify("", frontmatter);
  const withoutOpeningDelimiter = serialized.startsWith("---\n")
    ? serialized.slice(4)
    : serialized;
  const closingDelimiterIndex = withoutOpeningDelimiter.indexOf("\n---");

  return closingDelimiterIndex === -1
    ? withoutOpeningDelimiter.trimEnd()
    : withoutOpeningDelimiter.slice(0, closingDelimiterIndex);
}

function ensureTrailingLF(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function stripTrailingLFs(value: string): string {
  return value.replace(/\n+$/u, "");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }

  return value;
}

function assertValidUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(
          "Markdown content contains invalid UTF-16 surrogates",
        );
      }
      index += 1;
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(
        "Markdown content contains invalid UTF-16 surrogates",
      );
    }
  }
}
