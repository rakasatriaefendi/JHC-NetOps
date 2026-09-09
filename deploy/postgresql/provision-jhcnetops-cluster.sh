#!/usr/bin/env bash
set -Eeuo pipefail

# REVIEWED FUTURE PROVISIONING ONLY. Run on the Mini PC only during an approved change window.
readonly PG_VERSION="16"
readonly CLUSTER="jhcnetops"
readonly PORT="5433"
readonly DATABASE="jhc_netops"
readonly OWNER_ROLE="jhc_netops_owner"
readonly APP_ROLE="jhc_netops_app"
readonly CONFIG_ROOT="/etc/postgresql/${PG_VERSION}/${CLUSTER}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fail() { printf 'JHC NetOps PostgreSQL provisioning error: %s\n' "$1" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fail "run as root during an approved provisioning window"
command -v pg_createcluster >/dev/null || fail "postgresql-common is unavailable"
command -v pg_lsclusters >/dev/null || fail "pg_lsclusters is unavailable"

# Never operate on 16/main. Existing 16/jhcnetops is validated and left unchanged;
# role/database reconciliation is deliberately a separate explicit script.
existing_cluster="$(pg_lsclusters --no-header | awk -v version="${PG_VERSION}" -v cluster="${CLUSTER}" '$1 == version && $2 == cluster { print $3 ":" $4 }')"
if [[ -n "${existing_cluster}" ]]; then
  [[ "${existing_cluster%%:*}" == "${PORT}" ]] || fail "existing dedicated cluster is not on port ${PORT}"
  [[ -d "${CONFIG_ROOT}" ]] || fail "existing dedicated cluster configuration is unavailable"
  printf '%s\n' \
    "Dedicated PostgreSQL ${PG_VERSION}/${CLUSTER} already exists on port ${PORT}; no cluster/config change made." \
    "Run deploy/postgresql/provision-jhcnetops-application.sh separately to reconcile NetOps roles/database."
  exit 0
fi
ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)${PORT}$" && fail "port ${PORT} is already in use"

pg_createcluster "${PG_VERSION}" "${CLUSTER}" --port "${PORT}" --start-conf=manual
[[ -d "${CONFIG_ROOT}" ]] || fail "dedicated cluster configuration was not created"

install -d -m 0750 "${CONFIG_ROOT}/conf.d"
install -m 0640 /dev/stdin "${CONFIG_ROOT}/conf.d/99-jhc-netops-isolation.conf" <<'CONF'
listen_addresses = '127.0.0.1'
port = 5433
password_encryption = 'scram-sha-256'
ssl = on
CONF

# This replaces only the NEW jhcnetops cluster's HBA. 16/main remains untouched.
install -m 0640 /dev/stdin "${CONFIG_ROOT}/pg_hba.conf" <<'HBA'
local   all          postgres                              peer
local   jhc_netops   jhc_netops_app                        scram-sha-256
host    jhc_netops   jhc_netops_app   127.0.0.1/32         scram-sha-256
local   all          all                                   reject
host    all          all              0.0.0.0/0             reject
host    all          all              ::0/0                 reject
HBA

pg_ctlcluster "${PG_VERSION}" "${CLUSTER}" start

"${SCRIPT_DIR}/provision-jhcnetops-application.sh"

printf '%s\n' \
  "Dedicated PostgreSQL ${PG_VERSION}/${CLUSTER} created on loopback port ${PORT}." \
  "Set the app password and enable login interactively next; this script never accepts or prints it:" \
  "  sudo -u postgres psql --cluster ${PG_VERSION}/${CLUSTER} -d postgres" \
  "  \\password ${APP_ROLE}" \
  "  ALTER ROLE ${APP_ROLE} LOGIN;" \
  "Then apply deploy/postgresql/apply-asset-migration.sql as documented."
