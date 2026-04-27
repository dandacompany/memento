# memento

> Bi-directional code-assistant memory sync (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf)

```bash
npm i -g @dantelabs/memento
```

## Why memento?

Code assistants keep their long-lived instructions in different files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, and more. Switching between assistants, or using several in the same project, easily splits the context you meant to keep consistent. memento keeps those memory files synchronized across providers without forcing a single source of truth.

## Features

- 6 provider adapters: Claude Code, Codex, Gemini CLI, Antigravity, Cursor, and Windsurf.
- 3-tier memory model: `project`, `project-local`, and `global`.
- Bi-directional sync across matching memory identities.
- Conflict resolution with `lww`, `prompt`, and `fail` strategies.
- `watch` mode for continuous local synchronization.
- Automatic backup before writes, with restore support.
- Round-trip-safe markdown handling for LF normalization, BOM removal, and frontmatter preservation.
- Tested command and core behavior: 471 passing tests at v0.1.0.

## Quick Start

```bash
memento init
memento status
memento sync
```

Example:

```text
$ memento init
Created .memento/config.toml

$ memento sync
Detected 4 active providers
Synced project/agents-md:main across Claude Code, Codex, Gemini CLI
Backup written to .memento/backup/2026-04-27T12-00-00-000Z
```

## Provider Matrix

| Provider | project | project-local | global |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md`, `AGENTS.md` | `CLAUDE.local.md` | `~/.claude/CLAUDE.md` |
| Codex | `AGENTS.md` | `AGENTS.local.md` | `~/.codex/AGENTS.md` |
| Gemini CLI | `GEMINI.md` | `GEMINI.local.md` | `~/.gemini/GEMINI.md` |
| Antigravity | `.agent/skills/**`, `memory-bank/**` | `memory-bank/**.local.md` | `~/.gemini/antigravity/skills/**`, `~/.gemini/GEMINI.md`, `~/.antigravity/` |
| Cursor | `.cursor/rules/*.mdc`, legacy `.cursorrules` | `.cursor/rules/*.local.mdc` | `~/.cursor/rules/*.mdc` |
| Windsurf | `.windsurf/rules/*.md`, legacy `.windsurfrules` | `.windsurf/rules/*.local.md` | `~/.windsurf/rules/*.md` |

Gemini CLI and Antigravity share `~/.gemini/GEMINI.md`; memento handles that shared global path once.

## CLI Commands

| Command | Description |
| --- | --- |
| `memento init` | Create `.memento/config.toml` for the current project. |
| `memento status` | Show detected providers, tiers, and sync state. |
| `memento sync` | Synchronize memory files across active providers. |
| `memento watch` | Watch memory files and sync changes continuously. |
| `memento diff` | Show differences between grouped memory documents. |
| `memento restore` | List or restore automatic backups. |
| `memento global` | Run init/status/sync/watch/diff/restore against global memory. |
| `memento install-skill` | Install the Claude Code skill manually. |
| `memento uninstall-skill` | Remove the installed Claude Code skill. |

Run `memento <command> --help` for full options.

## Conflict Resolution

memento groups equivalent memory files by tier and identity, then compares their normalized bodies against the last sync cache.

- `lww`: last write wins. The file with the newest modified time becomes the version propagated to the group.
- `prompt`: interactive mode. memento asks which provider should win, can show the full diff, or lets you skip the group.
- `fail`: CI-friendly mode. memento exits with an unresolved conflict instead of writing changes.

By default, TTY sessions use `prompt`, non-TTY sessions use `lww`, and `memento watch` uses `lww`.

## Backup & Restore

memento creates a backup before writing provider memory files.

```bash
memento restore --list
memento restore --at 2026-04-27T12-00-00-000Z
```

Use `--group <key>` to restore a specific memory group when needed.

## Configuration

Project configuration lives in `.memento/config.toml`.

```toml
[providers.claude-code]
enabled = true
auto = true

[providers.codex]
enabled = true
auto = true

[mapping]
"rule:ts" = [
  "cursor:.cursor/rules/typescript.mdc",
  "windsurf:.windsurf/rules/typescript.md",
]

[exclude]
paths = [
  "~/.antigravity/brain/**",
  "**/conversations/**",
]
```

Mappings let you force multiple provider files into the same memory identity. Excludes keep generated, private, or high-churn paths out of sync.

## Claude Code Skill Integration

The npm package includes a Claude Code skill for using memento from Claude. It is installed automatically by the package `postinstall` script when Claude's skills directory is available.

If the automatic install is skipped, run:

```bash
memento install-skill
```

To remove it:

```bash
memento uninstall-skill
```

## Demo

```text
$ memento status
Provider        project       project-local       global
Claude Code     active        active              available
Codex           active        active              available
Gemini CLI      active        inactive            available
Cursor          active        inactive            available

$ memento diff
project/agents-md:main
  Claude Code, Codex, Gemini CLI differ by 2 lines

$ memento sync --strategy prompt
? Which version should win? Claude Code
Synced project/agents-md:main to 3 providers
```

## Project Status

v0.1.0 is an alpha release of the MVP described in the [design document](docs/bluekiwi/specs/2026-04-25-memento-design.md) and [implementation plan](docs/bluekiwi/specs/2026-04-25-memento-implementation-plan.md). The CLI surface is usable, but provider behavior and file mappings may evolve before v1.0.

## License

MIT

## Author

Dante <datapod.k@gmail.com>
