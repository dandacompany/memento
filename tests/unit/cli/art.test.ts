import { describe, expect, test } from "vitest";

import { mementoBanner } from "../../../src/cli/art.js";

describe("CLI art", () => {
  test("renders the memento banner without ANSI color", () => {
    const banner = mementoBanner({
      caption: "Version",
      version: "1.2.3",
      color: false,
    });

    expect(banner).toContain("__  __");
    expect(banner).toContain("Version");
    expect(banner).toContain("v1.2.3");
    expect(banner).not.toContain("\u001b[");
  });

  test("can render the banner with ANSI color", () => {
    const banner = mementoBanner({ caption: "Help", color: true });

    expect(banner).toContain("\u001b[");
    expect(banner).toContain("Help");
  });
});
