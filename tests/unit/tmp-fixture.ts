import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

interface TmpDirectory {
  name: string;
  removeCallback: () => void;
}

interface TmpModule {
  dirSync: (options: { unsafeCleanup: boolean }) => TmpDirectory;
}

const require = createRequire(import.meta.url);
// tmp has no bundled TypeScript declarations, and this phase intentionally avoids @types/tmp.
let tmp: TmpModule | null = null;

try {
  tmp = require("tmp");
} catch {
  tmp = null;
}

export function fixtureDir(): string {
  if (tmp) {
    return tmp.dirSync({ unsafeCleanup: true }).name;
  }

  return fs.mkdtempSync(path.join(os.tmpdir(), "memento-"));
}
