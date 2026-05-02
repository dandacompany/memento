import { AntigravityAdapter } from "../../adapters/antigravity.js";
import { ClaudeCodeAdapter } from "../../adapters/claude-code.js";
import { CodexAdapter } from "../../adapters/codex.js";
import { CursorAdapter } from "../../adapters/cursor.js";
import { GeminiCliAdapter } from "../../adapters/gemini-cli.js";
import {
  AdapterRegistry,
  createDefaultRegistry,
} from "../../adapters/registry.js";
import { WindsurfAdapter } from "../../adapters/windsurf.js";

export function createCliRegistry(cwd = process.cwd()): AdapterRegistry {
  const registry = createDefaultRegistry();

  registry.register(new AntigravityAdapter(cwd));
  registry.register(new ClaudeCodeAdapter(cwd));
  registry.register(new CodexAdapter(cwd));
  registry.register(new CursorAdapter(cwd));
  registry.register(new GeminiCliAdapter(cwd));
  registry.register(new WindsurfAdapter(cwd));

  return registry;
}
