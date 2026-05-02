# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-02

### Added

- Added `memento import <source>` for importing assistant memory and selected resources from another project into the current project.

### Changed

- Updated README and Korean README for resource sync, MCP secret handling, and cross-project import workflows.
- Release automation now skips npm publish when the package version already exists.

## [0.2.0] - 2026-05-02

### Added

- Added skill bundle synchronization for supported provider skill directories.
- Added MCP server definition synchronization for supported provider config files.
- Added resource-aware `status`, `sync`, `diff`, and `watch` options: `--resources`, `--scope`, `--no-skills`, and `--no-mcp`.

## [0.1.3] - 2026-04-30

### Added

- Added an ANSI memento banner to help, version, install, and postinstall output.
- Added `memento update` for updating the global CLI install from npm.

## [0.1.2] - 2026-04-30

### Fixed

- Fixed the npm bin entrypoint so globally installed `memento` runs when launched through npm's symlink.
- Fixed `memento watch` so internal `.memento` cache and backup writes do not retrigger no-op sync loops.

## [0.1.1] - 2026-04-30

### Fixed

- Fixed the published CLI failing at startup because the conflict prompt imported a dev-only `tmp` package.

## [0.1.0] - 2026-04-27

### Added

- Initial release of memento - bi-directional code-assistant memory sync
- 6 provider adapters: Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf
- 3-tier memory model: project / project-local / global
- 9 CLI commands: init, status, sync, watch, diff, restore, global, install-skill, uninstall-skill
- Conflict resolution with three strategies (lww / prompt / fail)
- Automatic backup before write with restore command
- Claude Code skill auto-installation via npm postinstall
- Round-trip-safe markdown normalization (LF, BOM, frontmatter preservation)

[0.3.0]: https://github.com/dandacompany/memento/releases/tag/v0.3.0
[0.2.0]: https://github.com/dandacompany/memento/releases/tag/v0.2.0
[0.1.3]: https://github.com/dandacompany/memento/releases/tag/v0.1.3
[0.1.2]: https://github.com/dandacompany/memento/releases/tag/v0.1.2
[0.1.1]: https://github.com/dandacompany/memento/releases/tag/v0.1.1
[0.1.0]: https://github.com/dandacompany/memento/releases/tag/v0.1.0
