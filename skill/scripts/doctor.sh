#!/usr/bin/env bash
# Diagnose installation: CLI version, ~/.claude/skills/memento existence, ~/.memento config status
set -e

status=0

info() {
  printf '%s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1"
  status=1
}

info "memento doctor"

if command -v memento >/dev/null 2>&1; then
  version="$(memento --version 2>/dev/null || true)"
  if [ -n "$version" ]; then
    info "CLI: $version"
  else
    warn "memento CLI was found, but version could not be read."
  fi
else
  warn "memento CLI is not installed. Install with: npm i -g @dantelabs/memento"
fi

skill_dir="${HOME}/.claude/skills/memento"
if [ -d "$skill_dir" ]; then
  info "Claude Code skill: $skill_dir"
  if [ -f "$skill_dir/SKILL.md" ]; then
    info "Skill manifest: present"
  else
    warn "Skill directory exists but SKILL.md is missing."
  fi
else
  warn "Claude Code skill is not installed at $skill_dir"
fi

global_dir="${HOME}/.memento"
global_config="${global_dir}/config.toml"
if [ -d "$global_dir" ]; then
  info "Global context: $global_dir"
  if [ -f "$global_config" ]; then
    info "Global config: present"
  else
    warn "Global context exists but config.toml is missing. Run: memento global init"
  fi
else
  warn "Global context is not initialized. Run: memento global init"
fi

if [ "$status" -eq 0 ]; then
  info "Doctor checks passed."
else
  info "Doctor checks completed with warnings."
fi

exit "$status"
