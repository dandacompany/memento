#!/usr/bin/env bash
set -e
if ! command -v memento >/dev/null 2>&1; then
  echo "memento CLI가 설치되어 있지 않습니다."
  echo "설치: npm i -g @dantelabs/memento"
  exit 3
fi
memento --version
