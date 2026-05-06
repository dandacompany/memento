# Global Memory Sync Scenario

Global memory sync uses the `~/.memento` context instead of a project root. It aligns user-level memory for Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, and Windsurf.

Common global memory paths:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex CLI: `~/.codex/AGENTS.md`
- Gemini CLI: `~/.gemini/GEMINI.md`

Codex can be detected for global sync when `~/.codex` exists, even if `~/.codex/AGENTS.md` has not been created yet. If another provider has global `agents-md:main` memory, memento can create the missing Codex global memory target during sync.

## 1. Initialize The Global Context

```bash
memento global init
```

## 2. Inspect Global Status

```bash
memento global status
```

## 3. Preview Global Sync

```bash
memento global sync --dry-run
memento global sync --provider codex --resources memory --dry-run
memento global diff --all --unified
```

## 4. Run Global Sync

```bash
memento global sync
```

## 5. Watch Global Memory

```bash
memento global watch
```

## 6. Restore

List backups first, then restore the required snapshot.

```bash
memento global restore --list
memento global restore --at <timestamp>
```
