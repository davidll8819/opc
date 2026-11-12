#!/bin/zsh
set -euo pipefail
cd "${0:A:h}"
export PATH="$PWD/.local/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"
node scripts/setup-local.mjs
if [[ -x .local/services/bin/pg_ctl && -x .local/services/bin/redis-server ]]; then
  node scripts/native-services.mjs start
else
  if ! docker info >/dev/null 2>&1; then colima start --cpu 2 --memory 4; fi
  docker compose -p wishtaday-local up -d --wait
fi
node --env-file=.env scripts/bootstrap-local.mjs
npm run build
node scripts/local-process.mjs start
if [[ -f .local/production-runtime/native-ready ]]; then
  node scripts/operations-mac.mjs start
  node scripts/service-watchdog.mjs start
fi
open http://localhost:3000
