import path from "node:path";

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split(path.sep).join("/");
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegexSource(pattern: string): string {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      const afterGlobstar = pattern[index + 2];

      if (afterGlobstar === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }

      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegex(char);
  }

  return source;
}

export function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);
  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`);

  if (regex.test(normalizedPath)) {
    return true;
  }

  if (!normalizedPattern.includes("/")) {
    return regex.test(path.posix.basename(normalizedPath));
  }

  return false;
}
