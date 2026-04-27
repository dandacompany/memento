# 단일 프로젝트 사용 시나리오

이 흐름은 한 프로젝트 안에서 Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf 메모리를 함께 관리할 때 사용한다.

## 1. 초기화

```bash
cd /path/to/project
memento init
```

특정 프로바이더만 포함하려면 쉼표로 지정한다.

```bash
memento init --providers claude-code,codex,gemini-cli
```

## 2. 상태 확인

```bash
memento status
```

자동화나 로그 수집에서는 JSON 출력을 사용한다.

```bash
memento status --json
```

## 3. 쓰기 전 확인

```bash
memento sync --dry-run
memento diff --all --unified
```

## 4. 동기화

```bash
memento sync
```

충돌 처리를 명시하려면 strategy를 지정한다.

```bash
memento sync --strategy prompt
memento sync --strategy fail
memento sync --strategy lww
```

## 5. 자동 동기

```bash
memento watch
```

watch는 백그라운드 작업 중 최신 수정본 기준(lww)으로 변경을 반영한다.
