# memento Command Cheatsheet

| Command                    | Context           | Key Options                                                     | Purpose                                  |
| -------------------------- | ----------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `memento init`             | Current project   | `--force`, `--providers <list>`                                 | Create `.memento/config.toml`            |
| `memento status`           | Current project   | `--json`, `--tier <t>`, `--include-global`                      | Show active providers and sync state     |
| `memento sync`             | Current project   | `--dry-run`, `--strategy <lww/prompt/fail>`, `--tier <t>`, `--provider <id>`, `--yes`, `--include-global` | Synchronize memory bidirectionally |
| `memento watch`            | Current project   | `--debounce <ms>`                                               | Watch files and sync automatically       |
| `memento diff`             | Current project   | `--group <key>`, `--all`, `--unified`                           | Show unsynchronized differences          |
| `memento restore`          | Current project   | `--list`, `--at <timestamp>`, `--group <key>`                   | List or restore backups                  |
| `memento global init`      | `~/.memento`      | `--force`, `--providers <list>`                                 | Initialize the global context            |
| `memento global status`    | `~/.memento`      | `--json`, `--tier <t>`, `--include-global`                      | Show global sync state                   |
| `memento global sync`      | `~/.memento`      | `--dry-run`, `--strategy <lww/prompt/fail>`, `--tier <t>`, `--provider <id>`, `--resources <list>`, `--yes`, `--include-global` | Synchronize global memory |
| `memento global watch`     | `~/.memento`      | `--debounce <ms>`                                               | Watch global memory and sync             |
| `memento global diff`      | `~/.memento`      | `--group <key>`, `--all`, `--unified`                           | Show global differences                  |
| `memento global restore`   | `~/.memento`      | `--list`, `--at <timestamp>`, `--group <key>`                   | Restore global backups                   |
| `memento install-skill`    | Claude Code skill | `--force`, `--dry-run`                                          | Install or repair the skill              |
| `memento uninstall-skill`  | Claude Code skill | none                                                            | Remove the skill                         |

Conflict strategy option: `--strategy <lww|prompt|fail>`.

Codex global memory target preview:

```bash
memento global sync --provider codex --resources memory --dry-run
```

## Exit Codes

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | Success                                      |
| 1    | General error                                |
| 2    | Unresolved conflict with `--strategy fail`   |
| 3    | Not initialized                              |
| 4    | No active providers                          |
