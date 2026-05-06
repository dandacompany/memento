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
memento sync --dry-run
memento diff --all --unified
```

## 4. Sync

```bash
memento sync
```

Choose a conflict strategy when needed.

```bash
memento sync --strategy prompt
memento sync --strategy fail
memento sync --strategy lww
```

## 5. Watch

```bash
memento watch
```

Watch mode applies local changes with the latest-file-wins strategy after file updates settle.
