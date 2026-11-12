#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
export PATH="$PWD/.local/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node scripts/service-watchdog.mjs stop
if [[ -f .local/production-runtime/native-ready ]]; then
  node scripts/operations-mac.mjs stop
fi
node scripts/local-process.mjs stop
if [[ -x .local/services/bin/pg_ctl && -x .local/services/bin/redis-server ]]; then
  node scripts/native-services.mjs stop
else
  docker compose -p wishtaday-local stop
fi
