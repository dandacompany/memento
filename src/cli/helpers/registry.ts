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

export function createCliRegistry(): AdapterRegistry {
  const registry = createDefaultRegistry();

  registry.register(new AntigravityAdapter());
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  registry.register(new CursorAdapter());
  registry.register(new GeminiCliAdapter());
  registry.register(new WindsurfAdapter());

  return registry;
}
