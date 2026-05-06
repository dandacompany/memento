---
name: memento
description: 'Synchronize code assistant memory across Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, and Windsurf. Use when users want shared provider memory, global memory sync, memento sync, or multi-assistant context portability.'
---

# memento - Code Assistant Memory Sync

## When To Use

- The user switches between Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, or Windsurf.
- The user wants to move memory, rules, skills, or `AGENTS.md`-style instructions from one assistant to another.
- The user wants to manage global memory such as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or `~/.gemini/GEMINI.md`.

## Core Commands

| Command                    | Purpose                                      |
| -------------------------- | -------------------------------------------- |
| `memento init`             | Initialize the current project               |
| `memento status`           | Show active providers and sync state         |
| `memento sync`             | Synchronize memory bidirectionally           |
| `memento watch`            | Continuously sync after file changes         |
| `memento diff`             | Show unsynchronized differences              |
| `memento restore`          | Restore provider files from backups          |
| `memento global <cmd>`     | Operate in the `~/.memento` global context   |
| `memento install-skill`    | Install or repair the Claude Code skill      |
| `memento uninstall-skill`  | Remove the Claude Code skill                 |

## Cheatsheet

| Task                                | Command                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| Initialize a project                | `memento init`                                                |
| Initialize selected providers       | `memento init --providers claude-code,codex`                  |
| Inspect current state               | `memento status`                                              |
| Output machine-readable status      | `memento status --json`                                       |
| Preview writes                      | `memento sync --dry-run`                                      |
| Sync with latest-file-wins strategy | `memento sync --strategy lww`                                 |
| Resolve conflicts interactively     | `memento sync --strategy prompt`                              |
| Fail on conflicts                   | `memento sync --strategy fail`                                |
| Watch for changes                   | `memento watch`                                               |
| Review diffs                        | `memento diff --all --unified`                                |
| List backups                        | `memento restore --list`                                      |
| Initialize global memory            | `memento global init`                                         |
| Sync global memory                  | `memento global sync`                                         |
| Preview Codex global memory only    | `memento global sync --provider codex --resources memory --dry-run` |
| Diagnose skill installation         | `./scripts/doctor.sh`                                         |

## Workflow

1. Run `memento init` from the project root to create `.memento/config.toml`.
2. Run `memento status` to see detected providers and grouped memory.
3. Run `memento sync --dry-run` before writing files.
4. Run `memento sync` when the preview is acceptable.
5. Use `memento watch` during active work if automatic local sync is useful.

## Global Memory

Use `memento global <cmd>` when synchronizing user-level memory instead of project memory.

```bash
memento global init
memento global status
memento global sync --dry-run
memento global sync
memento global watch
```

Codex global memory uses `~/.codex/AGENTS.md`. If Codex CLI is installed or `~/.codex` exists, Codex can participate in global sync. When another global provider has an `agents-md:main` memory document, memento can create a missing `~/.codex/AGENTS.md` target during global memory sync. Use `--resources memory` with `--provider codex` to preview only Codex memory writes.

## Troubleshooting

| Symptom                    | Check                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| `memento` is not found     | Install with `npm i -g @dantelabs/memento` and run `scripts/ensure-cli.sh` |
| Project is not initialized | Run `memento init` from the project root                            |
| No active providers        | Check supported CLIs, provider config directories, or memory files. Codex also uses `~/.codex` as a signal |
| Sync conflicts             | Run `memento diff --all --unified`, then `memento sync --strategy prompt` |
| Skill is missing           | Run `memento install-skill`, then `scripts/doctor.sh`               |
| Skill should be removed    | Run `memento uninstall-skill`                                       |

## Reference Files

- `examples/single-project.md`: single-project workflow
- `examples/global-sync.md`: global memory sync workflow
- `references/command-cheatsheet.md`: full command and option summary
