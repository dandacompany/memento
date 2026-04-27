# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/dandacompany/memento/releases/tag/v0.1.0
