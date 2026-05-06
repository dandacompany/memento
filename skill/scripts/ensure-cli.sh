#!/usr/bin/env bash
set -e
if ! command -v memento >/dev/null 2>&1; then
  echo "memento CLI is not installed."
  echo "Install with: npm i -g @dantelabs/memento"
  exit 3
fi
memento --version
