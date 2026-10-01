#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_BIN="/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node"
readonly PROJECT_ROOT="/var/www/jhc/jhc_noc/current"
readonly RUNNER_MAIN="${PROJECT_ROOT}/runner/src/main.mjs"
readonly RUNNER_ENV="/var/www/jhc/jhc_noc/shared/runner/.env"
readonly RUNNER_CONFIG="/var/www/jhc/jhc_noc/shared/runner/config.json"

fail() {
  printf 'JHC NetOps runner launcher error: %s\n' "$1" >&2
  exit 1
}

[[ -x "$NODE_BIN" ]] || fail "Node.js 22 executable is unavailable"
[[ -d "$PROJECT_ROOT" ]] || fail "active project root is unavailable"
[[ -r "$RUNNER_MAIN" ]] || fail "runner entrypoint is unavailable"
[[ -r "$RUNNER_ENV" ]] || fail "runner environment file is unavailable"
[[ -r "$RUNNER_CONFIG" ]] || fail "runner configuration file is unavailable"

set -a
# The environment file is a trusted, service-account-readable deployment file.
. "$RUNNER_ENV"
set +a

case "${PERSISTENCE_AUTHORITY:-}" in
  local_postgres)
    [[ -n "${LOCAL_BACKEND_URL:-}" ]] || fail "runner environment is missing LOCAL_BACKEND_URL"
    [[ -n "${LOCAL_BACKEND_TOKEN:-}" ]] || fail "runner environment is missing LOCAL_BACKEND_TOKEN"
    ;;
  supabase)
    [[ -n "${SUPABASE_URL:-}" ]] || fail "runner environment is missing SUPABASE_URL"
    [[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] || fail "runner environment is missing SUPABASE_SERVICE_ROLE_KEY"
    ;;
  *) fail "runner environment has missing or invalid PERSISTENCE_AUTHORITY" ;;
esac

cd "$PROJECT_ROOT"
exec "$NODE_BIN" "$RUNNER_MAIN" --config "$RUNNER_CONFIG"
