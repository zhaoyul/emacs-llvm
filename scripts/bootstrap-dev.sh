#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile=false
  pnpm build
else
  echo "pnpm is not installed; core TypeScript implementation has no external runtime dependencies." >&2
  npm run build
fi
