# Single Project Scenario

Use this workflow when a single project contains memory for Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, or Windsurf.

## 1. Initialize

```bash
cd /path/to/project
memento init
```

Limit initialization to selected providers with a comma-separated list.

```bash
memento init --providers claude-code,codex,gemini-cli
```

## 2. Inspect Status

```bash
memento status
```

Use JSON output for automation and log collection.

```bash
memento status --json
```

## 3. Preview Writes

```bash
memento sync --strategy fail --dry-run
memento diff --all --unified
```

If memory has accumulated across many sessions, consolidate it before writing. Follow `references/memory-consolidation.md`, then repeat the preflight.

## 4. Sync

```bash
memento sync --strategy prompt
```

Choose a conflict strategy when needed.

```bash
memento sync --strategy prompt
memento sync --strategy fail
memento sync --strategy lww
```

Use latest-file-wins only after confirming that provider root instruction files such as `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` can safely become identical.

## 5. Watch

```bash
memento watch
```

Watch mode applies local changes with the latest-file-wins strategy after file updates settle.
