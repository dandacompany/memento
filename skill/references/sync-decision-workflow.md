# memento Sync Decision Workflow

Use this workflow before running `memento sync` unless the user gave a precise command and already accepted the risk. The goal is to avoid copying provider-specific instruction files over each other when the user's intent is only to share selected memory.

## Clarifying Questions

Ask only the questions that are not already answered by the user or by local inspection.

1. Should this project be initialized first, or is `.memento/config.toml` already the intended config?
2. Is the target scope project-only, global-only, or project sync with global memory included?
3. Which providers are in scope: Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, Windsurf, or all active providers?
4. Is there one authoritative provider to copy from, or should memento keep memory bidirectional?
5. Should memory be consolidated before sync, or should the agent inspect status and diffs first, then decide?
6. Are root instruction files such as `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` intentionally different?

## Default Recommendation

When the user is unsure, recommend:

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

Use `--provider <id>` when the user wants to preview a single target provider, for example:

```bash
memento global sync --provider codex --resources memory --strategy fail --dry-run
```

## Direction Choices

| User intent | Recommended action |
| --- | --- |
| "Use Claude as the source" | Inspect Claude memory, preview target provider writes, then use prompt or a targeted import/sync path |
| "Use Codex as the source" | Inspect Codex memory, preview target provider writes, then use prompt or a targeted import/sync path |
| "Keep everyone aligned" | Use bidirectional sync after conflicts are reviewed |
| "Just expose facts to Codex" | Prefer a managed snapshot block or pointer list instead of replacing `AGENTS.md` |
| "I am not sure" | Run status and diff first; do not write until the user chooses |

## Root Instruction Files

Treat provider root instruction files as high-risk:

- Claude Code: `CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`
- Codex CLI: `AGENTS.md`, `AGENTS.local.md`, `~/.codex/AGENTS.md`
- Gemini CLI: `GEMINI.md`, `GEMINI.local.md`, `~/.gemini/GEMINI.md`

These files often contain provider-specific tool rules and should not be forced identical by LWW. If the user only wants shared facts, add or update a managed section:

```md
<!-- memento:snapshot begin -->
...
<!-- memento:snapshot end -->
```

Keep the rest of the provider file untouched.

## Write Protocol

1. Report the detected providers, tiers, and conflict groups.
2. Show the dry-run summary and the relevant diff.
3. Explain which files would be written and which strategy would choose the winner.
4. Ask for confirmation when the write would overwrite a root instruction file or delete memory.
5. Run the chosen command.
6. If the write was wrong, use `memento restore --list` and restore the relevant backup.
