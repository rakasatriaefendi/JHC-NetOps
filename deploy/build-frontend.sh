#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly FRONTEND_ROOT="${RELEASE_ROOT}/frontend"
readonly FRONTEND_ENV="/var/www/jhc/jhc_noc/shared/frontend/.env"
readonly NODE_DIR="/home/mini-pc/.nvm/versions/node/v22.23.2/bin"
readonly NODE_BIN="${NODE_DIR}/node"
readonly NPM_BIN="${NODE_DIR}/npm"

fail() {
  printf 'JHC NetOps frontend build error: %s\n' "$1" >&2
  exit 1
}

[[ -x "$NODE_BIN" ]] || fail "Node.js 22 executable is unavailable"
[[ -x "$NPM_BIN" ]] || fail "Node.js 22 npm executable is unavailable"
[[ -d "$FRONTEND_ROOT" ]] || fail "release frontend directory is unavailable"
[[ -r "${FRONTEND_ROOT}/package.json" ]] || fail "frontend package manifest is unavailable"
[[ -r "$FRONTEND_ENV" ]] || fail "frontend environment file is unavailable"

set -a
. "$FRONTEND_ENV"
set +a

[[ -n "${NEXT_PUBLIC_SITE_URL:-}" ]] || fail "frontend environment is missing NEXT_PUBLIC_SITE_URL"
[[ "${PERSISTENCE_AUTHORITY:-}" = "local_postgres" ]] || fail "frontend PERSISTENCE_AUTHORITY must be local_postgres"

export NODE_ENV=production
export PATH="${NODE_DIR}:${PATH}"
cd "$FRONTEND_ROOT"
"$NPM_BIN" run build
