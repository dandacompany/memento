# Provider-Aware Memory Consolidation

Run this workflow before sync when the user asks for memory cleanup, when many sessions have accumulated, or when status/diff shows noisy conflicts. It generalizes the Claude-oriented `dream` workflow to all memento providers.

## Discovery

Find the active memory locations before editing. Prefer explicit user paths, then provider-native locations.

| Provider | Project memory | Global memory |
| --- | --- | --- |
| Claude Code | `.claude/memory/`, `CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/projects/<hashed-cwd>/memory/` | `~/.claude/CLAUDE.md` |
| Codex CLI | `AGENTS.md`, `AGENTS.local.md` | `~/.codex/AGENTS.md`, `~/.codex/memories/`, `~/.codex/memory/` |
| Gemini CLI | `GEMINI.md`, `GEMINI.local.md` | `~/.gemini/GEMINI.md` |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules` | `~/.cursor/rules/*.mdc` |
| Windsurf | `.windsurf/rules/*.md`, `.windsurfrules` | `~/.windsurf/rules/*.md` |
| Antigravity | `.agent/skills/**/SKILL.md`, `memory-bank/**/*.md` | `~/.gemini/antigravity/skills/**/SKILL.md` |

Report the memory directory or files, how they were found, and whether they are provider-specific root instruction files or structured memory entries.

## Phase 1: Inventory

1. Read indexes such as `MEMORY.md` when present.
2. List memory files and managed sections.
3. Identify orphaned files, broken links, duplicate entries, and root instruction files that should remain provider-specific.
4. Report counts before editing.

## Phase 2: Temporal Normalization

1. Find relative dates such as "today", "yesterday", "last week", "recently", "just now", and equivalents in other languages.
2. Convert them to absolute dates using frontmatter, git history, or file mtime as the anchor.
3. Flag malformed entries that are missing required frontmatter for their provider format.
4. Keep edits minimal and factual.

## Phase 3: Staleness Verification

1. Verify referenced file paths with fast file search.
2. Verify functions, classes, variables, commands, and config keys with text search.
3. Verify URLs and live endpoints only when the user asked for current truth or when the memory would otherwise be misleading.
4. Mark stale facts for update or removal. Prefer updating when the newer fact can be verified.

## Phase 4: Contradiction Resolution

1. Group memories by topic, provider, and scope.
2. Resolve direct contradictions by keeping the most recent verified fact.
3. If multiple facts are current, keep both and explain provider or scope differences.
4. Do not collapse provider-specific behavioral rules into a generic rule unless all affected providers share the same behavior.

## Phase 5: Deduplication And Merging

1. Merge entries with more than 50 percent overlapping facts.
2. Preserve unique facts, exact commands, and file paths.
3. Keep the clearer filename or provider-native location.
4. Ask before deleting files. If uncertain, archive or leave a note instead.

## Phase 6: Index Rebuild

1. Rebuild `MEMORY.md` or the provider-native index when present.
2. Keep entries short enough to scan.
3. Group by active project facts, user preferences, operational references, and archive.
4. Put stale or historical notes in an archive section rather than active guidance.

## Phase 7: Sync Readiness Check

After consolidation, run:

```bash
memento status
memento sync --strategy fail --dry-run
memento diff --all --unified
```

For global memory:

```bash
memento global status
memento global sync --strategy fail --dry-run
memento global diff --all --unified
```

## Report Format

```md
## Memory Consolidation Report

Date: YYYY-MM-DD
Scope: project | global | project+global
Providers: claude-code, codex, gemini-cli, antigravity, cursor, windsurf
Locations: <paths>

Changes:
- Removed: <files and reasons>
- Updated: <files and summaries>
- Merged: <source -> target>
- Created: <files>
- Index: rebuilt | unchanged | not present

Stale references found: N
Contradictions resolved: N
Duplicates merged: N
Sync preflight: passed | conflicts remain
```

## Rules

- Never delete memory without verifying staleness and getting confirmation.
- Never print secrets while inspecting memory.
- Preserve provider-native frontmatter, comments, and managed-section markers.
- Use managed sections when sharing facts across provider root instruction files.
- Prefer `--strategy fail --dry-run` before any sync write.
