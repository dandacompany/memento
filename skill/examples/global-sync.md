# 글로벌 메모리 동기 시나리오

글로벌 메모리는 프로젝트 루트가 아니라 `~/.memento/` 컨텍스트를 기준으로 Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Windsurf의 홈 디렉터리 메모리를 통합한다.

## 1. 글로벌 컨텍스트 초기화

```bash
memento global init
```

## 2. 글로벌 상태 확인

```bash
memento global status
```

## 3. 글로벌 동기 미리보기

```bash
memento global sync --dry-run
memento global diff --all --unified
```

## 4. 글로벌 동기 실행

```bash
memento global sync
```

## 5. 글로벌 자동 동기

```bash
memento global watch
```

## 6. 복구

백업 목록을 확인한 뒤 필요한 시점으로 복구한다.

```bash
memento global restore --list
memento global restore --at <timestamp>
```
