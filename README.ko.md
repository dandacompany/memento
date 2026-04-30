<div align="center">

# memento

**AI 코딩 에이전트 메모리 양방향 동기화 CLI**

Claude Code, Codex CLI, Gemini CLI, Antigravity, Cursor, Windsurf의 메모리 파일을 하나의 영구 source of truth 없이 서로 맞춰 둡니다.

[![npm](https://img.shields.io/npm/v/@dantelabs/memento?color=4169e1)](https://www.npmjs.com/package/@dantelabs/memento)
[![CI](https://github.com/dandacompany/memento/actions/workflows/ci.yml/badge.svg)](https://github.com/dandacompany/memento/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-lightgrey.svg)](LICENSE)

[빠른 설치](#빠른-설치) · [프로바이더 매트릭스](#프로바이더-매트릭스) · [CLI](#cli) · [설정](#설정) · [안전 모델](#안전-모델)

[English](README.md)

</div>

---

## memento란?

memento는 AI 코딩 에이전트가 사용하는 장기 지침과 메모리 파일을 동기화하는 Node.js CLI입니다.

에이전트마다 컨텍스트 저장 위치가 다릅니다.

- Claude Code: `CLAUDE.md`, `~/.claude/CLAUDE.md`
- Codex CLI: `AGENTS.md`, `~/.codex/AGENTS.md`
- Gemini CLI: `GEMINI.md`, `~/.gemini/GEMINI.md`
- Cursor: `.cursor/rules/*.mdc`
- Windsurf: `.windsurf/rules/*.md`
- Antigravity: `.agent/skills/**`, `memory-bank/**`, 일부 글로벌 메모리 경로

여러 에이전트를 한 저장소에서 함께 쓰거나 도구를 바꿔 가며 쓰면 이 파일들이 쉽게 갈라집니다. memento는 각 프로바이더의 파일 형식을 읽고, 공통 내부 문서 모델로 정규화하고, 충돌을 해결한 뒤, 원래 프로바이더 파일에 다시 씁니다. 파일을 수정하기 전에는 항상 백업을 남깁니다.

목표는 실용적인 로컬 동기화입니다.

```text
CLAUDE.md ─┐
AGENTS.md ─┼─ memento sync ─▶ 프로젝트 메모리를 모든 에이전트에 반영
GEMINI.md ┘

.cursor/rules/typescript.mdc ─┐
.windsurf/rules/typescript.md ─┴─ 같은 rule identity로 동기화
```

memento는 서버를 실행하지 않고, 메모리 파일을 업로드하지 않으며, git을 대체하지 않습니다. 로컬 머신과 저장소 안의 에이전트 컨텍스트를 일관되게 유지하기 위한 CLI입니다.

---

## 빠른 설치

### 요구 사항

- Node.js 18 이상
- npm
- 프로젝트 안의 지원 프로바이더 메모리 파일, 또는 `memento init`에 전달할 명시적 프로바이더 목록

### 1. CLI 설치

```bash
npm i -g @dantelabs/memento
```

설치 확인:

```bash
memento --version
memento --help
```

### 2. 프로젝트 초기화

저장소 루트에서 실행합니다.

```bash
memento init
```

`init`은 `.memento/config.toml`을 만들고, 런타임 파일을 `.gitignore`에 추가합니다.

```gitignore
.memento/cache.json
.memento/backup/
```

프로바이더가 자동 감지되지 않으면 원하는 프로바이더를 강제로 지정합니다.

```bash
memento init --providers claude-code,codex,gemini-cli,cursor,windsurf
```

사용 가능한 provider id:

```text
claude-code, codex, gemini-cli, antigravity, cursor, windsurf
```

### 3. 상태 확인

```bash
memento status
```

일반적인 출력은 활성 프로바이더와 메모리 그룹을 보여줍니다.

```text
memento status

Providers
✓ claude-code (active)
✓ codex (active)
✓ gemini-cli (active)

project
✓ synced  agents-md:main  claude-code, codex, gemini-cli
```

### 4. 동기화 미리보기와 실행

먼저 미리보기:

```bash
memento sync --dry-run
```

실제 쓰기:

```bash
memento sync
```

충돌을 대화형으로 고르려면:

```bash
memento sync --strategy prompt
```

CI나 스크립트에서 충돌 시 실패하도록 하려면:

```bash
memento sync --strategy fail
```

### 5. 작업 중 계속 동기화

```bash
memento watch
```

`watch`는 last-write-wins 방식으로 충돌을 처리합니다. 여러 에이전트를 오가며 메모리 파일이 바뀌는 로컬 개발 세션에 맞춰져 있습니다.

---

## 핵심 개념

### 메모리 tier

memento는 메모리 파일을 세 단계로 다룹니다.

| Tier | 의미 | 대표 위치 | git 처리 |
| --- | --- | --- | --- |
| `project` | 저장소 공유 메모리 | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/*.mdc` | 보통 커밋 |
| `project-local` | 한 머신에서만 쓰는 프로젝트 메모리 | `CLAUDE.local.md`, `AGENTS.local.md`, `*.local.mdc` | 보통 ignore |
| `global` | 프로젝트 밖 사용자 전역 메모리 | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` | 커밋하지 않음 |

기본 프로젝트 명령은 `project`, `project-local` tier를 동기화합니다. 글로벌 파일까지 포함하려면 `--include-global`을 쓰고, 글로벌 메모리만 다루려면 `memento global ...` 명령을 사용합니다.

### 메모리 identity

memento는 모든 파일을 무작정 서로 복사하지 않습니다. 의미가 같은 파일끼리 그룹화합니다.

| 파일 | Identity |
| --- | --- |
| `CLAUDE.md` | `agents-md:main` |
| `AGENTS.md` | `agents-md:main` |
| `GEMINI.md` | `agents-md:main` |
| `.cursor/rules/typescript.mdc` | `rule:typescript` |
| `.windsurf/rules/typescript.md` | `rule:typescript` |
| `.agent/skills/git-flow/SKILL.md` | `skill:git-flow` |
| `memory-bank/core/state.md` | `memory-bank:core/state` |

같은 tier와 identity를 가진 파일은 하나의 그룹으로 비교되고 동기화됩니다. 예: `project/agents-md:main`.

### 영구 source of truth 없음

memento는 양방향 동기화 도구입니다. 어느 파일이 우승할지는 매 sync 실행 시 결정됩니다.

- 모든 파일이 같으면 아무것도 쓰지 않음
- 이전 sync 이후 한 파일만 바뀌었으면 그 변경을 전파
- 여러 파일이 서로 다르게 바뀌었으면 설정된 충돌 전략으로 결정

따라서 지금 사용 중인 에이전트에서 메모리를 편집해도 됩니다.

---

## 프로바이더 매트릭스

| Provider | Provider id | `project` | `project-local` | `global` |
| --- | --- | --- | --- | --- |
| Claude Code | `claude-code` | `CLAUDE.md`, `AGENTS.md` | `CLAUDE.local.md` | `~/.claude/CLAUDE.md` |
| Codex CLI | `codex` | `AGENTS.md` | `AGENTS.local.md` | `~/.codex/AGENTS.md` |
| Gemini CLI | `gemini-cli` | `GEMINI.md` | `GEMINI.local.md` | `~/.gemini/GEMINI.md` |
| Antigravity | `antigravity` | `.agent/skills/**`, `memory-bank/**` | `memory-bank/**.local.md` | `~/.gemini/antigravity/skills/**`, `~/.gemini/GEMINI.md`, `~/.antigravity/` |
| Cursor | `cursor` | `.cursor/rules/*.mdc`, legacy `.cursorrules` | `.cursor/rules/*.local.mdc` | `~/.cursor/rules/*.mdc` |
| Windsurf | `windsurf` | `.windsurf/rules/*.md`, legacy `.windsurfrules` | `.windsurf/rules/*.local.md` | `~/.windsurf/rules/*.md` |

Gemini CLI와 Antigravity는 `~/.gemini/GEMINI.md`를 함께 참조할 수 있습니다. memento는 이 공유 글로벌 경로를 한 번만 처리합니다.

---

## 자주 쓰는 워크플로

### Claude Code와 Codex만 시작하기

```bash
memento init --providers claude-code,codex
memento status
memento sync --strategy prompt
```

### 특정 프로바이더만 동기화

```bash
memento sync --provider codex
```

다른 프로바이더 파일을 수정한 뒤, 해결된 메모리를 한 프로바이더에만 다시 쓰고 싶을 때 유용합니다.

### 특정 tier만 동기화

```bash
memento sync --tier project
memento sync --tier project-local
```

### 프로젝트 sync에서 글로벌 메모리 포함

```bash
memento sync --include-global
```

### 글로벌 메모리만 관리

```bash
memento global init --providers claude-code,codex,gemini-cli
memento global status
memento global sync --strategy prompt
memento global watch
```

글로벌 명령은 `~/.memento/config.toml`을 사용하고, 글로벌 프로바이더 경로만 대상으로 합니다.

### CI에서 사용

프로바이더 메모리가 서로 다르면 실패하도록 `--strategy fail`을 사용합니다.

```bash
memento sync --strategy fail --dry-run
```

종료 코드 `2`는 해결되지 않은 충돌이 있다는 뜻입니다.

### 이전 버전 복원

```bash
memento restore --list
memento restore --at 2026-04-30T07-37-00_342Z
```

한 그룹만 복원:

```bash
memento restore --at 2026-04-30T07-37-00_342Z --group project/agents-md:main
```

---

## CLI

### 전역 옵션

| Option | 설명 |
| --- | --- |
| `-v, --version` | 설치된 memento 버전 출력 |
| `--debug` | 디버그 출력과 stack trace 출력 |
| `--json` | 지원되는 명령에서 JSON lines 출력 |
| `--quiet` | 에러가 아닌 출력 억제 |

### 명령

| Command | 설명 |
| --- | --- |
| `memento init` | 현재 프로젝트에 `.memento/config.toml` 생성 |
| `memento status` | 프로바이더 감지, tier, sync 상태 출력 |
| `memento sync` | 활성 프로바이더 간 메모리 파일 동기화 |
| `memento watch` | 메모리 파일 변경을 감시하고 계속 동기화 |
| `memento diff` | 그룹화된 메모리 문서 차이 출력 |
| `memento restore` | 자동 백업 목록 조회, 복원, 정리 |
| `memento global` | 글로벌 메모리에 대해 `init`, `status`, `sync`, `watch`, `diff`, `restore` 실행 |
| `memento install-skill` | 포함된 Claude Code skill 수동 설치 |
| `memento uninstall-skill` | 설치된 Claude Code skill 제거 |

설치된 버전의 정확한 옵션은 `memento <command> --help`로 확인합니다.

### `memento init`

```bash
memento init [--force] [--providers <list>]
```

| Option | 설명 |
| --- | --- |
| `--force` | 기존 `.memento/config.toml` 덮어쓰기 |
| `--providers <list>` | 활성화할 provider id를 쉼표로 구분 |

`init`은 모든 지원 프로바이더를 probe하고, config를 만들고, `.gitignore`에 runtime cache와 backup 파일을 추가합니다.

### `memento status`

```bash
memento status [--tier <tier>] [--include-global] [--json]
```

| Option | 설명 |
| --- | --- |
| `--tier <tier>` | `project`, `project-local`, `global` 중 하나만 표시 |
| `--include-global` | 프로젝트 status에 글로벌 파일 포함 |
| `--json` | JSON 출력 |

### `memento sync`

```bash
memento sync [--dry-run] [--strategy <strategy>] [--tier <tier>] [--provider <id>] [--yes] [--include-global]
```

| Option | 설명 |
| --- | --- |
| `--dry-run` | 파일 쓰기 없이 sync 미리보기 |
| `--strategy <strategy>` | 충돌 전략: `lww`, `prompt`, `fail` |
| `--tier <tier>` | 하나의 memory tier만 대상으로 지정 |
| `--provider <id>` | 하나의 provider id만 대상으로 지정 |
| `--yes` | 비대화형 기본값 허용. 현재는 `lww` 사용 |
| `--include-global` | 프로젝트 sync에 글로벌 메모리 포함 |

### `memento watch`

```bash
memento watch [--debounce <ms>] [--tier <tier>] [--provider <id>] [--include-global]
```

`watch`는 프로바이더 메모리 파일을 감시하고 변경이 안정화된 뒤 sync를 실행합니다.

| Option | 설명 |
| --- | --- |
| `--debounce <ms>` | debounce 시간(ms). 기본값 `500` |
| `--tier <tier>` | 하나의 tier만 감시 |
| `--provider <id>` | 하나의 provider만 감시 |
| `--include-global` | 프로젝트 watch 모드에 글로벌 메모리 포함 |

### `memento diff`

```bash
memento diff [--group <key>] [--all] [--unified] [--tier <tier>] [--provider <id>] [--include-global] [--json]
```

| Option | 설명 |
| --- | --- |
| `--group <key>` | `project/agents-md:main` 같은 특정 conflict group만 표시 |
| `--all` | 모든 diff group 표시 |
| `--unified` | unified diff 출력 |
| `--tier <tier>` | 하나의 memory tier만 대상으로 지정 |
| `--provider <id>` | 하나의 provider id만 대상으로 지정 |
| `--include-global` | 프로젝트 diff에 글로벌 메모리 포함 |
| `--json` | JSON 출력 |

### `memento restore`

```bash
memento restore [--list] [--at <timestamp>] [--group <key>] [--prune <count>]
```

| Option | 설명 |
| --- | --- |
| `--list` | 사용 가능한 restore point 목록 |
| `--at <timestamp>` | `--list`에 나온 timestamp로 복원 |
| `--group <key>` | 하나의 memory group만 복원 |
| `--prune <count>` | 최신 N개 백업만 남기고 오래된 백업 삭제 |

### `memento global`

```bash
memento global init
memento global status
memento global sync
memento global watch
memento global diff
memento global restore
```

글로벌 하위 명령은 프로젝트 명령과 거의 같지만 `~/.memento`의 글로벌 memento context를 사용합니다.

### 종료 코드

| Code | 의미 |
| --- | --- |
| `0` | 성공 |
| `1` | 일반 에러 |
| `2` | 해결되지 않은 충돌. 보통 `--strategy fail`에서 발생 |
| `3` | 초기화되지 않음. `memento init` 필요 |
| `4` | 활성 프로바이더 없음 |

---

## 설정

프로젝트 설정:

```text
.memento/config.toml
```

글로벌 설정:

```text
~/.memento/config.toml
```

예시:

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

### 프로바이더 설정

| Field | 의미 |
| --- | --- |
| `enabled` | sync에 참여할지 여부 |
| `auto` | 자동 감지 결과를 존중할지 여부 |
| `include_orphan` | 앱이나 CLI가 설치되어 있지 않아도 메모리 파일을 포함할지 여부 |

### Mapping override

기본 파일명 규칙으로는 같은 identity가 되지 않는 두 파일을 같은 메모리로 취급하려면 `[mapping]`을 사용합니다.

```toml
[mapping]
"rule:backend-style" = [
  "cursor:.cursor/rules/backend.mdc",
  "windsurf:.windsurf/rules/api-style.md",
]
```

### Exclude

비공개, 생성물, 대용량, 변동이 잦은 파일은 exclude에 넣습니다.

```toml
[exclude]
paths = [
  "**/secrets/**",
  "**/scratch/**",
]
```

---

## 충돌 해결

memento는 정규화된 문서 본문과 이전 sync cache를 비교합니다.

| Strategy | 동작 | 적합한 상황 |
| --- | --- | --- |
| `lww` | last write wins. mtime이 가장 최신인 파일이 승리 | 자동화, watch 모드, 빠른 로컬 sync |
| `prompt` | 어떤 버전을 사용할지 묻고, diff를 보거나 수동 편집 가능 | 대화형 터미널 세션 |
| `fail` | 충돌 그룹을 쓰지 않고 종료 코드 `2`로 종료 | CI, pre-commit check, 엄격한 워크플로 |

예시:

```bash
memento sync --strategy lww
memento sync --strategy prompt
memento sync --strategy fail --dry-run
```

`memento watch`는 항상 `lww`를 사용합니다. 장기 실행 watcher는 안전하게 대화형 prompt에서 멈출 수 없기 때문입니다.

---

## 백업과 복원

프로바이더 메모리 파일을 쓰기 전에 memento는 이전 내용을 아래에 저장합니다.

```text
.memento/backup/<timestamp>/
```

백업은 로컬 runtime artifact이며 커밋하면 안 됩니다.

자주 쓰는 명령:

```bash
memento restore --list
memento restore --at <timestamp>
memento restore --at <timestamp> --group project/agents-md:main
memento restore --prune 10
```

잘못된 winner가 선택되었거나, 예전 메모리 내용을 확인하고 싶거나, sync 이후 provider 파일이 수동으로 깨졌을 때 restore를 사용합니다.

---

## Claude Code Skill

npm 패키지에는 Claude Code 안에서 memento를 다루기 위한 skill이 포함되어 있습니다.

`npm i -g @dantelabs/memento` 중 postinstall 단계는 Claude skill 디렉터리가 있을 때 skill 복사를 시도합니다. 자동 설치가 건너뛰어졌거나 수동 재설치를 원하면:

```bash
memento install-skill
```

제거:

```bash
memento uninstall-skill
```

npm 설치 중 자동 skill 설치를 건너뛰기:

```bash
MEMENTO_SKIP_SKILL_INSTALL=1 npm i -g @dantelabs/memento
```

---

## 안전 모델

memento는 파일 쓰기에 보수적으로 동작합니다.

- 로컬 전용: 파일은 내 머신에서 읽고 씁니다. memento는 메모리 내용을 업로드하지 않습니다.
- 명시적 설정: 프로젝트 sync에는 `.memento/config.toml`이 필요합니다.
- dry-run 지원: 쓰기 전에 `memento sync --dry-run`으로 확인할 수 있습니다.
- 자동 백업: 모든 write에는 restore point가 있습니다.
- 충돌 전략: 수동 제어는 `prompt`, CI는 `fail`을 사용합니다.
- 공유 글로벌 dedupe: Gemini/Antigravity 공유 글로벌 경로는 한 번만 처리합니다.
- watch ignore: `.memento` cache와 backup write는 sync loop를 다시 트리거하지 않습니다.

팀 사용 권장 사항:

- 팀 전체가 공유해야 하는 `project` 메모리 파일은 커밋합니다.
- `project-local`과 `.memento/cache.json`은 git에서 제외합니다.
- 기존 저장소에서 첫 sync 전 `memento diff --all --unified`로 차이를 검토합니다.
- 메모리 drift가 merge를 막아야 한다면 CI에서 `memento sync --strategy fail --dry-run`을 사용합니다.

---

## 개발자와 후원

memento는 실전 AI 에이전트 워크플로를 위한 도구들을 만드는 **Dante Labs**에서 개발하고 관리합니다.

| 링크 | 설명 |
| --- | --- |
| **GitHub** | [dandacompany/memento](https://github.com/dandacompany/memento) |
| **npm** | [@dantelabs/memento](https://www.npmjs.com/package/@dantelabs/memento) |
| **YouTube** | [@dante-labs](https://youtube.com/@dante-labs) |
| **Email** | [dante@dante-labs.com](mailto:dante@dante-labs.com) |
| **후원** | [Buy Me a Coffee](https://buymeacoffee.com/dante.labs) |

memento가 시간을 절약해 주거나, 에이전트 컨텍스트를 깔끔하게 유지하는 데 도움이 되거나, 일상 워크플로의 일부가 되었다면 후원을 통해 프로젝트 유지보수와 신규 provider adapter, 실제 환경 호환성 테스트를 지원할 수 있습니다.

이슈, 버그 리포트, provider mapping 요청은 GitHub에서 환영합니다.

---

## License

[MIT](LICENSE)  
Copyright (c) 2026 Dante Labs.

---

<div align="center">

**Dante Labs** · **YouTube** [@dante-labs](https://youtube.com/@dante-labs) · **Email** [dante@dante-labs.com](mailto:dante@dante-labs.com) · **후원** [Buy Me a Coffee](https://buymeacoffee.com/dante.labs)

</div>
