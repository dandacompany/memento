# memento Command Cheatsheet

| 명령                      | 컨텍스트          | 주요 옵션                                     | 용도                                  |
| ------------------------- | ----------------- | --------------------------------------------- | ------------------------------------- |
| `memento init`            | 현재 프로젝트     | `--force`, `--providers <list>`               | `.memento/config.toml` 생성           |
| `memento status`          | 현재 프로젝트     | `--json`, `--tier <t>`, `--include-global`    | 활성 프로바이더와 동기 상태 확인      |
| `memento sync`            | 현재 프로젝트     | `--dry-run`, `--strategy <lww/prompt/fail>`, `--tier <t>`, `--provider <id>`, `--yes`, `--include-global` | 메모리 양방향 동기 |
| `memento watch`           | 현재 프로젝트     | `--debounce <ms>`                             | 파일 변경을 감시하고 자동 동기        |
| `memento diff`            | 현재 프로젝트     | `--group <key>`, `--all`, `--unified`         | 동기되지 않은 차이 표시               |
| `memento restore`         | 현재 프로젝트     | `--list`, `--at <timestamp>`, `--group <key>` | 백업 목록 확인 또는 복구              |
| `memento global init`     | `~/.memento/`     | `--force`, `--providers <list>`               | 글로벌 컨텍스트 초기화                |
| `memento global status`   | `~/.memento/`     | `--json`, `--tier <t>`, `--include-global`    | 글로벌 상태 확인                      |
| `memento global sync`     | `~/.memento/`     | `--dry-run`, `--strategy <lww/prompt/fail>`, `--tier <t>`, `--provider <id>`, `--yes`, `--include-global` | 글로벌 메모리 동기 |
| `memento global watch`    | `~/.memento/`     | `--debounce <ms>`                             | 글로벌 메모리 자동 동기               |
| `memento global diff`     | `~/.memento/`     | `--group <key>`, `--all`, `--unified`         | 글로벌 차이 표시                      |
| `memento global restore`  | `~/.memento/`     | `--list`, `--at <timestamp>`, `--group <key>` | 글로벌 백업 복구                      |
| `memento install-skill`   | Claude Code skill | `--force`, `--dry-run`                        | skill 수동 설치 또는 postinstall 복구 |
| `memento uninstall-skill` | Claude Code skill | 없음                                          | skill 제거                            |

Conflict strategy option: `--strategy <lww|prompt|fail>`.

## 종료 코드

| Code | 의미                                  |
| ---- | ------------------------------------- |
| 0    | 성공                                  |
| 1    | 일반 오류                             |
| 2    | 해결되지 않은 충돌(`--strategy fail`) |
| 3    | 초기화되지 않음                       |
| 4    | 활성 프로바이더 없음                  |
