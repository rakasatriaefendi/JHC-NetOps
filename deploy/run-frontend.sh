#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_BIN="/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node"
readonly PROJECT_ROOT="/var/www/jhc/jhc_noc/current"
readonly FRONTEND_ROOT="${PROJECT_ROOT}/frontend"
readonly FRONTEND_ENV="/var/www/jhc/jhc_noc/shared/frontend/.env"
readonly NEXT_BIN="${FRONTEND_ROOT}/node_modules/next/dist/bin/next"
readonly PORT_GUARD="${PROJECT_ROOT}/deploy/check-frontend-port.mjs"
readonly FRONTEND_HOST="192.168.1.130"
readonly FRONTEND_PORT="3401"

fail() {
  printf 'JHC NetOps frontend launcher error: %s\n' "$1" >&2
  exit 1
}

[[ -x "$NODE_BIN" ]] || fail "Node.js 22 executable is unavailable"
[[ -d "$PROJECT_ROOT" ]] || fail "active project root is unavailable"
[[ -d "$FRONTEND_ROOT" ]] || fail "frontend directory is unavailable"
[[ -d "${FRONTEND_ROOT}/.next" ]] || fail "frontend production build is unavailable"
[[ -r "$NEXT_BIN" ]] || fail "Next.js runtime entrypoint is unavailable"
[[ -r "$PORT_GUARD" ]] || fail "frontend port guard is unavailable"
[[ -r "$FRONTEND_ENV" ]] || fail "frontend environment file is unavailable"

set -a
# The environment file is a trusted, service-account-readable deployment file.
. "$FRONTEND_ENV"
set +a

export NODE_ENV=production
cd "$FRONTEND_ROOT"
"$NODE_BIN" "$PORT_GUARD" --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
exec "$NODE_BIN" "$NEXT_BIN" start --hostname "$FRONTEND_HOST" --port "$FRONTEND_PORT"
