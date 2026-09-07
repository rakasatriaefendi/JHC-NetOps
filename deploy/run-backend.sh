#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_BIN="/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node"
readonly PROJECT_ROOT="/var/www/jhc/jhc_noc/current"
readonly BACKEND_ROOT="${PROJECT_ROOT}/backend"
readonly BACKEND_ENV="/var/www/jhc/jhc_noc/shared/backend/.env"
readonly BACKEND_MAIN="${BACKEND_ROOT}/dist/main.js"

fail() {
  printf 'JHC NetOps backend launcher error: %s\n' "$1" >&2
  exit 1
}

[[ -x "$NODE_BIN" ]] || fail "Node.js 22 executable is unavailable"
[[ -d "$PROJECT_ROOT" ]] || fail "active project root is unavailable"
[[ -d "$BACKEND_ROOT" ]] || fail "backend directory is unavailable"
[[ -r "$BACKEND_ENV" ]] || fail "backend environment file is unavailable"
[[ -r "$BACKEND_MAIN" ]] || fail "compiled backend entrypoint is unavailable"

set -a
# The environment file is a trusted, service-account-readable deployment file.
. "$BACKEND_ENV"
set +a

export NODE_ENV=production
cd "$BACKEND_ROOT"
exec "$NODE_BIN" "$BACKEND_MAIN"
