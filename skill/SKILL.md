---
name: memento
description: '코드 어시스턴트(Claude Code/Codex/Gemini CLI/Antigravity/Cursor/Windsurf) 메모리를 양방향 동기화. 사용자가 여러 코드 어시스턴트 메모리를 통합 관리하고자 할 때 사용. 트리거: "메모리 동기", "프로바이더 메모리 통합", "memento sync", "여러 어시스턴트 메모리 공유".'
---

# memento — Code Assistant Memory Sync

## 언제 사용하는가

- 여러 코드 어시스턴트(Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf)를 동시에 또는 번갈아 사용하는 사용자
- 한 어시스턴트에서 작성한 메모리(룰/스킬/AGENTS.md 등)를 다른 어시스턴트로 옮기고 싶을 때
- 글로벌 메모리(~/.claude/CLAUDE.md ↔ ~/.gemini/GEMINI.md 등)를 통합 관리

## 핵심 명령

| 명령                      | 용도                                            |
| ------------------------- | ----------------------------------------------- |
| `memento init`            | 현재 프로젝트 초기화(.memento/config.toml 생성) |
| `memento status`          | 활성 프로바이더 + 메모리 동기 상태 확인         |
| `memento sync`            | 메모리 양방향 동기                              |
| `memento watch`           | 백그라운드 자동 동기(lww strategy)              |
| `memento diff`            | 동기되지 않은 메모리 차이 표시                  |
| `memento restore`         | 백업에서 복구                                   |
| `memento global <cmd>`    | ~/.memento/ 글로벌 컨텍스트로 실행              |
| `memento install-skill`   | Claude Code skill 수동 설치 또는 복구           |
| `memento uninstall-skill` | Claude Code skill 제거                          |

## Cheatsheet

| 상황                           | 명령                                         |
| ------------------------------ | -------------------------------------------- |
| 프로젝트에 memento 설정 생성   | `memento init`                               |
| 특정 프로바이더만 설정 생성    | `memento init --providers claude-code,codex` |
| 현재 동기 상태 확인            | `memento status`                             |
| JSON 상태 출력                 | `memento status --json`                      |
| 변경 사항 미리보기             | `memento sync --dry-run`                     |
| 최신 수정본 기준으로 자동 병합 | `memento sync --strategy lww`                |
| 충돌 시 대화형 선택            | `memento sync --strategy prompt`             |
| 충돌이 있으면 실패             | `memento sync --strategy fail`               |
| 자동 동기 루프 시작            | `memento watch`                              |
| 차이 확인                      | `memento diff --all --unified`               |
| 백업 목록 확인                 | `memento restore --list`                     |
| 글로벌 메모리 초기화           | `memento global init`                        |
| 글로벌 메모리 동기             | `memento global sync`                        |
| Skill 설치 상태 진단           | `./scripts/doctor.sh`                        |

## 동작 흐름

1. `memento init`으로 프로젝트 루트에 `.memento/config.toml`을 만든다.
2. `memento status`로 감지된 프로바이더와 동기 대상 메모리를 확인한다.
3. `memento sync --dry-run`으로 쓰기 전에 변경 방향과 충돌 여부를 확인한다.
4. 문제가 없으면 `memento sync`를 실행한다.
5. 반복 작업 중에는 `memento watch`를 켜서 파일 변경 시 자동 동기화한다.

## 글로벌 메모리

프로젝트별 설정이 아니라 홈 디렉터리 기준 메모리를 통합하려면 `memento global <cmd>`를 사용한다.

```bash
memento global init
memento global status
memento global sync
memento global watch
```

## 트러블슈팅

| 증상                          | 확인                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `memento` 명령을 찾을 수 없음 | `npm i -g @dantelabs/memento`로 CLI를 설치한 뒤 `skill/scripts/ensure-cli.sh`를 실행   |
| 프로젝트가 초기화되지 않음    | 프로젝트 루트에서 `memento init` 실행                                                  |
| 활성 프로바이더가 없음        | Claude Code/Codex/Gemini CLI/Antigravity/Cursor/Windsurf 메모리 파일이 있는지 확인     |
| 충돌로 동기 실패              | `memento diff --all --unified`로 차이를 확인하고 `memento sync --strategy prompt` 사용 |
| Skill 설치가 누락됨           | `memento install-skill` 실행 후 `skill/scripts/doctor.sh`로 확인                       |
| Skill 제거가 필요함           | `memento uninstall-skill` 실행                                                         |

## 참고 파일

- `examples/single-project.md`: 단일 프로젝트 사용 흐름
- `examples/global-sync.md`: 글로벌 메모리 동기 흐름
- `references/command-cheatsheet.md`: 명령과 옵션 전체 요약
