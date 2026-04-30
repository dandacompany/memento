<div align="center">

# memento

**Bi-directional memory sync for AI coding agents**

Keep Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, and Windsurf memory files aligned without choosing a single permanent source of truth.

[![npm](https://img.shields.io/npm/v/@dantelabs/memento?color=4169e1)](https://www.npmjs.com/package/@dantelabs/memento)
[![CI](https://github.com/dandacompany/memento/actions/workflows/ci.yml/badge.svg)](https://github.com/dandacompany/memento/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

[Quick Setup](#quick-setup) | [Provider Matrix](#provider-matrix) | [CLI](#cli) | [Configuration](#configuration) | [Safety](#safety-model)

[Korean](README.ko.md)

</div>

---

## What is memento?

memento is a Node.js CLI that synchronizes long-lived instruction and memory files used by AI coding agents.

Different agents store context in different places:

- Claude Code: `CLAUDE.md`, `~/.claude/CLAUDE.md`
- Codex CLI: `AGENTS.md`, `~/.codex/AGENTS.md`
- Gemini CLI: `GEMINI.md`, `~/.gemini/GEMINI.md`
- Cursor: `.cursor/rules/*.mdc`
- Windsurf: `.windsurf/rules/*.md`
- Antigravity: `.agent/skills/**`, `memory-bank/**`, selected global memory paths

When you switch tools or use several agents in the same repository, those files can drift. memento reads each provider's native file format, normalizes it into a shared internal document model, resolves conflicts, writes changes back to the original provider files, and creates backups before modifying anything.

The design goal is practical local synchronization:

```text
CLAUDE.md \
AGENTS.md  > memento sync > same project memory everywhere
GEMINI.md /

.cursor/rules/typescript.mdc \
.windsurf/rules/typescript.md  > same rule identity
```

memento does not run a server, does not upload memory files, and does not replace git. It is a local CLI for keeping agent context consistent on your machine and in your repository.

---

## Quick Setup

### Prerequisites

- Node.js 18 or newer
- npm
- At least one supported agent memory file in the project, or an explicit provider list passed to `memento init`

### 1. Install the CLI

```bash
npm i -g @dantelabs/memento
```

Verify the install:

```bash
memento --version
memento --help
```

### 2. Initialize a project

Run this from the repository root:

```bash
memento init
```

`init` creates `.memento/config.toml` and adds these runtime files to `.gitignore`:

```gitignore
.memento/cache.json
.memento/backup/
```

If memento cannot auto-detect a provider, force the providers you want:

```bash
memento init --providers claude-code,codex,gemini-cli,cursor,windsurf
```

Valid provider ids are:

```text
claude-code, codex, gemini-cli, antigravity, cursor, windsurf
```

### 3. Inspect status

```bash
memento status
```

Typical output shows which providers are active and how memory files are grouped:

```text
memento status

Providers
ok claude-code (active)
ok codex (active)
ok gemini-cli (active)

project
ok synced  agents-md:main  claude-code, codex, gemini-cli
```

### 4. Preview or run a sync

Preview first:

```bash
memento sync --dry-run
```

Then write changes:

```bash
memento sync
```

For an interactive conflict prompt:

```bash
memento sync --strategy prompt
```

For CI or scripts that should fail on unresolved conflicts:

```bash
memento sync --strategy fail
```

### 5. Keep files synchronized while you work

```bash
memento watch
```

`watch` uses last-write-wins conflict handling and is designed for local development sessions where provider memory files may change as you switch tools.

---

## Core Concepts

### Memory tiers

memento treats memory files as one of three tiers:

| Tier | Meaning | Typical location | Git behavior |
| --- | --- | --- | --- |
| `project` | Shared repository memory | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc` | Usually committed |
| `project-local` | Local project memory for one machine | `CLAUDE.local.md`, `AGENTS.local.md`, `*.local.mdc` | Usually ignored |
| `global` | User-level memory outside a project | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` | Not committed |

By default, project commands sync `project` and `project-local` tiers. Use `--include-global` to include global files, or use `memento global ...` to operate only on global memory.

### Memory identities

memento does not simply copy every file to every other file. It groups files by semantic identity.

| File | Identity |
| --- | --- |
| `CLAUDE.md` | `agents-md:main` |
| `AGENTS.md` | `agents-md:main` |
| `GEMINI.md` | `agents-md:main` |
| `.cursor/rules/typescript.mdc` | `rule:typescript` |
| `.windsurf/rules/typescript.md` | `rule:typescript` |
| `.agent/skills/git-flow/SKILL.md` | `skill:git-flow` |
| `memory-bank/core/state.md` | `memory-bank:core/state` |

Files with the same tier and identity are compared and synchronized as a group, for example `project/agents-md:main`.

### No permanent source of truth

memento is bi-directional. The winning version for a group is chosen during each sync:

- if all files are identical, nothing is written
- if one file changed since the last sync, that change is propagated
- if multiple files changed differently, the configured conflict strategy decides what happens

This lets you edit memory in whichever agent you are using at the moment.

---

## Provider Matrix

| Provider | Provider id | `project` | `project-local` | `global` |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `CLAUDE.md`, `AGENTS.md` | `CLAUDE.local.md` | `~/.claude/CLAUDE.md` |
| Codex CLI | `codex` | `AGENTS.md` | `AGENTS.local.md` | `~/.codex/AGENTS.md` |
| Gemini CLI | `gemini-cli` | `GEMINI.md` | `GEMINI.local.md` | `~/.gemini/GEMINI.md` |
| Antigravity | `antigravity` | `.agent/skills/**`, `memory-bank/**` | `memory-bank/**.local.md` | `~/.gemini/antigravity/skills/**`, `~/.gemini/GEMINI.md`, `~/.antigravity/` |
| Cursor | `cursor` | `.cursor/rules/*.mdc`, legacy `.cursorrules` | `.cursor/rules/*.local.mdc` | `~/.cursor/rules/*.mdc` |
| Windsurf | `windsurf` | `.windsurf/rules/*.md`, legacy `.windsurfrules` | `.windsurf/rules/*.local.md` | `~/.windsurf/rules/*.md` |

Gemini CLI and Antigravity can both reference `~/.gemini/GEMINI.md`; memento deduplicates that shared global path.

---

## Common Workflows

### Start with Claude Code and Codex only

```bash
memento init --providers claude-code,codex
memento status
memento sync --strategy prompt
```

### Sync only one provider

```bash
memento sync --provider codex
```

This is useful when you want to write the resolved memory back to one provider after changing another provider's file.

### Sync only one tier

```bash
memento sync --tier project
memento sync --tier project-local
```

### Include global memory from a project sync

```bash
memento sync --include-global
```

### Manage only global memory

```bash
memento global init --providers claude-code,codex,gemini-cli
memento global status
memento global sync --strategy prompt
memento global watch
```

Global commands use `~/.memento/config.toml` and operate on global provider paths only.

### Use memento in CI

Use `--strategy fail` to make the command fail when provider memory files disagree:

```bash
memento sync --strategy fail --dry-run
```

Exit code `2` means unresolved conflicts were found.

### Restore a previous version

```bash
memento restore --list
memento restore --at 2026-04-30T07-37-00_342Z
```

Restore a single group:

```bash
memento restore --at 2026-04-30T07-37-00_342Z --group project/agents-md:main
```

---

## CLI

### Global options

| Option | Description |
| --- | --- |
| `-v, --version` | Print the installed memento version |
| `--debug` | Print debug output and stack traces |
| `--json` | Emit JSON lines where supported |
| `--quiet` | Suppress non-error output |

### Commands

| Command | Description |
| --- | --- |
| `memento init` | Create `.memento/config.toml` for the current project |
| `memento status` | Show provider detection, tiers, and sync state |
| `memento sync` | Synchronize memory files across active providers |
| `memento watch` | Watch memory files and synchronize changes continuously |
| `memento diff` | Show differences between grouped memory documents |
| `memento restore` | List, restore, or prune automatic backups |
| `memento global` | Run `init`, `status`, `sync`, `watch`, `diff`, or `restore` against global memory |
| `memento update` | Update the global memento CLI install |
| `memento install-skill` | Install the bundled Claude Code skill manually |
| `memento uninstall-skill` | Remove the installed Claude Code skill |

Run `memento <command> --help` for the exact options supported by your installed version.

### `memento init`

```bash
memento init [--force] [--providers <list>]
```

| Option | Description |
| --- | --- |
| `--force` | Overwrite an existing `.memento/config.toml` |
| `--providers <list>` | Comma-separated provider ids to enable |

`init` probes all supported providers, creates a config, and updates `.gitignore` for runtime cache and backup files.

### `memento status`

```bash
memento status [--tier <tier>] [--include-global] [--json]
```

| Option | Description |
| --- | --- |
| `--tier <tier>` | Filter to `project`, `project-local`, or `global` |
| `--include-global` | Include global files in project status |
| `--json` | Emit JSON output |

### `memento sync`

```bash
memento sync [--dry-run] [--strategy <strategy>] [--tier <tier>] [--provider <id>] [--yes] [--include-global]
```

| Option | Description |
| --- | --- |
| `--dry-run` | Preview the sync without writing files |
| `--strategy <strategy>` | Conflict strategy: `lww`, `prompt`, or `fail` |
| `--tier <tier>` | Filter to one memory tier |
| `--provider <id>` | Filter to one provider id |
| `--yes` | Accept non-interactive defaults; currently uses `lww` |
| `--include-global` | Include global memory in a project sync |

### `memento watch`

```bash
memento watch [--debounce <ms>] [--tier <tier>] [--provider <id>] [--include-global]
```

`watch` monitors provider memory files and runs sync after changes settle.

| Option | Description |
| --- | --- |
| `--debounce <ms>` | Debounce interval in milliseconds; default is `500` |
| `--tier <tier>` | Watch only one tier |
| `--provider <id>` | Watch only one provider |
| `--include-global` | Include global memory in project watch mode |

### `memento diff`

```bash
memento diff [--group <key>] [--all] [--unified] [--tier <tier>] [--provider <id>] [--include-global] [--json]
```

| Option | Description |
| --- | --- |
| `--group <key>` | Show one conflict group, such as `project/agents-md:main` |
| `--all` | Show all diff groups |
| `--unified` | Print unified diff output |
| `--tier <tier>` | Filter to one memory tier |
| `--provider <id>` | Filter to one provider id |
| `--include-global` | Include global memory in project diff mode |
| `--json` | Emit JSON output |

### `memento restore`

```bash
memento restore [--list] [--at <timestamp>] [--group <key>] [--prune <count>]
```

| Option | Description |
| --- | --- |
| `--list` | List available restore points |
| `--at <timestamp>` | Restore from a timestamp listed by `--list` |
| `--group <key>` | Restore one memory group |
| `--prune <count>` | Keep the newest N backups and remove older backups |

### `memento global`

```bash
memento global init
memento global status
memento global sync
memento global watch
memento global diff
memento global restore
```

The global subcommands mirror the project commands but use the global memento context at `~/.memento`.

### `memento update`

```bash
memento update
memento update --dry-run
```

`update` runs the npm global install command for the latest published release and shows the same memento ANSI header used by help and version output.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic error |
| `2` | Unresolved conflict, usually from `--strategy fail` |
| `3` | Not initialized; run `memento init` |
| `4` | No active providers |

---

## Configuration

Project configuration lives at:

```text
.memento/config.toml
```

Global configuration lives at:

```text
~/.memento/config.toml
```

Example:

```toml
[providers.claude-code]
enabled = true
auto = true
include_orphan = false

[providers.codex]
enabled = true
auto = true
include_orphan = false

[providers.gemini-cli]
enabled = true
auto = true
include_orphan = false

[providers.cursor]
enabled = true
auto = true
include_orphan = false

[providers.windsurf]
enabled = true
auto = true
include_orphan = false

[providers.antigravity]
enabled = false
auto = true
include_orphan = false

[mapping]
"rule:typescript" = [
  "cursor:.cursor/rules/typescript.mdc",
  "windsurf:.windsurf/rules/typescript.md",
]

[exclude]
paths = [
  "**/private/**",
  "**/generated/**",
]
```

### Provider settings

| Field | Meaning |
| --- | --- |
| `enabled` | Whether the provider participates in sync |
| `auto` | Whether automatic detection should be respected |
| `include_orphan` | Include memory files even when the provider app or CLI is not installed |

### Mapping overrides

Use `[mapping]` when two files should be treated as the same identity but their default filenames would not match.

```toml
[mapping]
"rule:backend-style" = [
  "cursor:.cursor/rules/backend.mdc",
  "windsurf:.windsurf/rules/api-style.md",
]
```

### Excludes

Use excludes for private, generated, large, or high-churn files.

```toml
[exclude]
paths = [
  "**/secrets/**",
  "**/scratch/**",
]
```

---

## Conflict Resolution

memento compares normalized document bodies and the previous sync cache.

| Strategy | Behavior | Best for |
| --- | --- | --- |
| `lww` | Last write wins; the newest modified file becomes the winner | automation, watch mode, quick local sync |
| `prompt` | Ask which version should win, show diff, or edit manually | interactive terminal sessions |
| `fail` | Exit with code `2` without writing conflicting groups | CI, pre-commit checks, strict workflows |

Examples:

```bash
memento sync --strategy lww
memento sync --strategy prompt
memento sync --strategy fail --dry-run
```

`memento watch` always uses `lww`, because a long-running file watcher cannot safely stop for interactive prompts.

---

## Backup & Restore

Before writing provider memory files, memento saves the previous contents under:

```text
.memento/backup/<timestamp>/
```

Backups are local runtime artifacts and should not be committed.

Common commands:

```bash
memento restore --list
memento restore --at <timestamp>
memento restore --at <timestamp> --group project/agents-md:main
memento restore --prune 10
```

Use restore when a sync chose the wrong winner, when you want to inspect older memory contents, or when a provider file was manually damaged after a sync.

---

## Claude Code Skill

The npm package includes a Claude Code skill for operating memento from inside Claude Code.

During `npm i -g @dantelabs/memento`, the package postinstall step attempts to copy the skill into Claude's skills directory when that directory is available. If auto-install is skipped or you want to reinstall manually:

```bash
memento install-skill
```

Remove it with:

```bash
memento uninstall-skill
```

Skip automatic skill installation during npm install:

```bash
MEMENTO_SKIP_SKILL_INSTALL=1 npm i -g @dantelabs/memento
```

---

## Safety Model

memento is intentionally conservative around writes.

- Local-only: files are read and written on your machine; memento does not upload memory content.
- Explicit config: project sync requires `.memento/config.toml`.
- Dry-run support: use `memento sync --dry-run` before writing.
- Automatic backups: every write has a restore point.
- Conflict strategies: choose `prompt` for manual control or `fail` for CI.
- Shared global dedupe: shared Gemini/Antigravity global paths are handled once.
- Watch ignore rules: `.memento` cache and backup writes do not retrigger sync loops.

Recommended team practice:

- Commit shared `project` memory files when they are meant for the whole repository.
- Keep `project-local` and `.memento/cache.json` out of git.
- Review `memento diff --all --unified` before the first sync in an existing repository.
- Use `memento sync --strategy fail --dry-run` in CI if memory drift should block merges.

---

## Developer & Support

memento is built and maintained by **Dante Labs** as part of a broader toolkit for practical AI-agent workflows.

| Link | Description |
| --- | --- |
| **GitHub** | [dandacompany/memento](https://github.com/dandacompany/memento) |
| **npm** | [@dantelabs/memento](https://www.npmjs.com/package/@dantelabs/memento) |
| **YouTube** | [@dante-labs](https://youtube.com/@dante-labs) |
| **Email** | [dante@dante-labs.com](mailto:dante@dante-labs.com) |
| **Support** | [Buy Me a Coffee](https://buymeacoffee.com/dante.labs) |

If memento saves you time, helps keep your agent context clean, or becomes part of your daily workflow, sponsorship is appreciated and helps fund continued maintenance, new provider adapters, and real-world compatibility testing.

Issues, bug reports, and provider mapping requests are welcome on GitHub.

---

## License

[MIT](LICENSE)  
Copyright (c) 2026 Dante Labs.

---

<div align="center">

**Dante Labs** · **YouTube** [@dante-labs](https://youtube.com/@dante-labs) · **Email** [dante@dante-labs.com](mailto:dante@dante-labs.com) · **Support** [Buy Me a Coffee](https://buymeacoffee.com/dante.labs)

</div>
