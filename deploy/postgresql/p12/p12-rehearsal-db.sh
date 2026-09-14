#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly PG_VERSION="16"
readonly CLUSTER="jhcnetops"
readonly PORT="5433"
readonly LIVE_DATABASE="jhc_netops"
readonly OWNER_ROLE="jhc_netops_owner"
readonly SHARED_ROOT="/var/www/jhc/jhc_noc/shared/p12"
readonly DATABASE_PATTERN='^jhc_netops_p12_[a-z0-9][a-z0-9_]{0,47}$'
readonly RUN_PATTERN='^[a-z0-9][a-z0-9_]{0,47}$'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)"
readonly SCHEMA_FILE="${REPOSITORY_ROOT}/backend/migrations/p12/001_supabase_application_schema.sql"

fail() { printf 'P12 rehearsal database error: %s\n' "$1" >&2; exit 1; }
usage() { fail "use: $0 prepare|clone-baseline|apply-schema|destroy <run_id> [exact_database_for_destroy]"; }

[[ "${EUID}" -eq 0 ]] || fail "run as root only during an approved P12 rehearsal window"
command -v pg_lsclusters >/dev/null || fail "pg_lsclusters is unavailable"
command -v sha256sum >/dev/null || fail "sha256sum is unavailable"
readonly OPERATOR_USER="${SUDO_USER:-}"
[[ "${OPERATOR_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ && "${OPERATOR_USER}" != "root" ]] || fail "invoke through sudo from the approved operator account"
id "${OPERATOR_USER}" >/dev/null 2>&1 || fail "approved operator account is unavailable"
readonly OPERATOR_GROUP="$(id -gn "${OPERATOR_USER}")"

readonly COMMAND="${1:-}"
readonly RUN_ID="${2:-}"
[[ "${RUN_ID}" =~ ${RUN_PATTERN} ]] || fail "run ID is invalid"
readonly DATABASE="jhc_netops_p12_${RUN_ID}"
[[ "${DATABASE}" =~ ${DATABASE_PATTERN} ]] || fail "rehearsal database name is invalid"
case "${DATABASE}" in "${LIVE_DATABASE}"|postgres|template0|template1) fail "forbidden database" ;; esac

readonly RUN_DIRECTORY="${SHARED_ROOT}/${RUN_ID}"
readonly MANIFEST_DIRECTORY="${RUN_DIRECTORY}/manifest"
readonly TARGET_MANIFEST="${MANIFEST_DIRECTORY}/rehearsal-target.env"
readonly BASELINE_HASH_MANIFEST="${MANIFEST_DIRECTORY}/local-baseline.sha256"
readonly BASELINE_DIRECTORY="${RUN_DIRECTORY}/local-baseline"
readonly BASELINE_DUMP="${BASELINE_DIRECTORY}/asset-baseline.dump"

cluster_line="$(pg_lsclusters --no-header | awk -v version="${PG_VERSION}" -v cluster="${CLUSTER}" '$1 == version && $2 == cluster { print $3 ":" $4 }')"
[[ -n "${cluster_line}" ]] || fail "dedicated cluster 16/jhcnetops is unavailable"
[[ "${cluster_line%%:*}" == "${PORT}" ]] || fail "dedicated cluster is not on port 5433"
[[ "${cluster_line#*:}" == "online" ]] || fail "dedicated cluster is not online"

psql_cluster=(runuser -u postgres -- psql --cluster "${PG_VERSION}/${CLUSTER}" --port "${PORT}" --set ON_ERROR_STOP=1 --no-psqlrc --tuples-only --no-align)
runtime_port="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW port')"
listen_addresses="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW listen_addresses')"
[[ "${runtime_port}" == "${PORT}" ]] || fail "runtime port is not 5433"
[[ "${listen_addresses}" == "127.0.0.1" ]] || fail "dedicated cluster is not loopback-only"

database_owner() {
  "${psql_cluster[@]}" --dbname postgres --set database_name="${1}" \
    --command "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'database_name'"
}

write_or_verify_manifest() {
  install -d -m 0711 -o root -g root "${SHARED_ROOT}"
  install -d -m 0750 -o "${OPERATOR_USER}" -g postgres "${RUN_DIRECTORY}"
  install -d -m 0700 -o "${OPERATOR_USER}" -g "${OPERATOR_GROUP}" \
    "${MANIFEST_DIRECTORY}" "${RUN_DIRECTORY}/source-snapshot" "${RUN_DIRECTORY}/reports"
  if [[ -f "${TARGET_MANIFEST}" ]]; then
    grep -Fxq "RUN_ID=${RUN_ID}" "${TARGET_MANIFEST}" || fail "run manifest ID mismatch"
    grep -Fxq "DATABASE=${DATABASE}" "${TARGET_MANIFEST}" || fail "run manifest database mismatch"
    grep -Fxq "CLUSTER=16/jhcnetops" "${TARGET_MANIFEST}" || fail "run manifest cluster mismatch"
    grep -Fxq "PORT=5433" "${TARGET_MANIFEST}" || fail "run manifest port mismatch"
    return
  fi
  local temporary="${TARGET_MANIFEST}.tmp.$$"
  printf 'RUN_ID=%s\nDATABASE=%s\nCLUSTER=16/jhcnetops\nPORT=5433\n' "${RUN_ID}" "${DATABASE}" > "${temporary}"
  chmod 0600 "${temporary}"
  chown "${OPERATOR_USER}:${OPERATOR_GROUP}" "${temporary}"
  mv -n -- "${temporary}" "${TARGET_MANIFEST}" || fail "run manifest already exists"
}

verify_manifest() {
  [[ -f "${TARGET_MANIFEST}" ]] || fail "exact rehearsal run manifest is missing"
  grep -Fxq "RUN_ID=${RUN_ID}" "${TARGET_MANIFEST}" || fail "run manifest ID mismatch"
  grep -Fxq "DATABASE=${DATABASE}" "${TARGET_MANIFEST}" || fail "run manifest database mismatch"
  grep -Fxq "CLUSTER=16/jhcnetops" "${TARGET_MANIFEST}" || fail "run manifest cluster mismatch"
  grep -Fxq "PORT=5433" "${TARGET_MANIFEST}" || fail "run manifest port mismatch"
}

prepare() {
  write_or_verify_manifest
  local owner
  owner="$(database_owner "${DATABASE}")"
  [[ -z "${owner}" ]] || fail "rehearsal database already exists; refuse to reuse unknown state"
  runuser -u postgres -- createdb --cluster "${PG_VERSION}/${CLUSTER}" --port "${PORT}" --owner "${OWNER_ROLE}" "${DATABASE}"
  printf 'Prepared isolated P12 rehearsal database %s.\n' "${DATABASE}"
}

clone_baseline() {
  verify_manifest
  [[ "$(database_owner "${DATABASE}")" == "${OWNER_ROLE}" ]] || fail "rehearsal database is unavailable or has an unexpected owner"
  user_table_count="$("${psql_cluster[@]}" --dbname "${DATABASE}" --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")"
  [[ "${user_table_count}" == "0" ]] || fail "rehearsal database is not empty before baseline restore"
  install -d -m 0700 -o postgres -g postgres "${BASELINE_DIRECTORY}"
  if [[ ! -f "${BASELINE_DUMP}" ]]; then
    local temporary_dump="${BASELINE_DUMP}.tmp.$$"
    if ! runuser -u postgres -- pg_dump --cluster "${PG_VERSION}/${CLUSTER}" --port "${PORT}" \
      --dbname "${LIVE_DATABASE}" --schema asset --format custom --serializable-deferrable \
      --file "${temporary_dump}"; then
      rm -f -- "${temporary_dump}"
      fail "consistent local baseline dump failed"
    fi
    mv -- "${temporary_dump}" "${BASELINE_DUMP}"
    chmod 0600 "${BASELINE_DUMP}"
  fi
  local baseline_hash
  baseline_hash="$(sha256sum "${BASELINE_DUMP}" | awk '{print $1}')"
  [[ "${baseline_hash}" =~ ^[0-9a-f]{64}$ ]] || fail "local baseline hash could not be calculated"
  if [[ -f "${BASELINE_HASH_MANIFEST}" ]]; then
    grep -Fxq "${baseline_hash}  asset-baseline.dump" "${BASELINE_HASH_MANIFEST}" || fail "local baseline artifact identity changed"
  else
    local temporary_hash="${BASELINE_HASH_MANIFEST}.tmp.$$"
    printf '%s  asset-baseline.dump\n' "${baseline_hash}" > "${temporary_hash}"
    chmod 0600 "${temporary_hash}"
    chown "${OPERATOR_USER}:${OPERATOR_GROUP}" "${temporary_hash}"
    mv -n -- "${temporary_hash}" "${BASELINE_HASH_MANIFEST}" || fail "local baseline identity already exists"
  fi
  runuser -u postgres -- pg_restore --cluster "${PG_VERSION}/${CLUSTER}" --port "${PORT}" \
    --dbname "${DATABASE}" --exit-on-error --single-transaction "${BASELINE_DUMP}"
  printf 'Restored immutable local asset baseline into %s.\n' "${DATABASE}"
}

apply_schema() {
  verify_manifest
  [[ -f "${SCHEMA_FILE}" ]] || fail "P12 rehearsal schema file is unavailable"
  [[ "$(database_owner "${DATABASE}")" == "${OWNER_ROLE}" ]] || fail "rehearsal database is unavailable or has an unexpected owner"
  "${psql_cluster[@]}" --dbname "${DATABASE}" --file "${SCHEMA_FILE}" >/dev/null
  printf 'Applied P12 application schema to %s.\n' "${DATABASE}"
}

destroy() {
  verify_manifest
  readonly CONFIRMED_DATABASE="${3:-}"
  [[ "${CONFIRMED_DATABASE}" == "${DATABASE}" ]] || fail "destroy requires the exact manifest database name"
  [[ "${CONFIRMED_DATABASE}" =~ ${DATABASE_PATTERN} ]] || fail "destroy database name is invalid"
  case "${CONFIRMED_DATABASE}" in "${LIVE_DATABASE}"|postgres|template0|template1) fail "refusing forbidden database" ;; esac
  [[ "$(database_owner "${CONFIRMED_DATABASE}")" == "${OWNER_ROLE}" ]] || fail "rehearsal database is unavailable or has an unexpected owner"
  runuser -u postgres -- dropdb --cluster "${PG_VERSION}/${CLUSTER}" --port "${PORT}" "${CONFIRMED_DATABASE}"
  printf 'Destroyed only rehearsal database %s; immutable artifacts were retained.\n' "${CONFIRMED_DATABASE}"
}

case "${COMMAND}" in
  prepare) prepare ;;
  clone-baseline) clone_baseline ;;
  apply-schema) apply_schema ;;
  destroy) destroy "$@" ;;
  *) usage ;;
esac
