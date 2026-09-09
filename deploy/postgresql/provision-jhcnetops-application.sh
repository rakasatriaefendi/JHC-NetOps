#!/usr/bin/env bash
set -Eeuo pipefail

# Reconciles only the NetOps roles/database inside the dedicated 16/jhcnetops cluster.
# It does not edit cluster configuration, restart PostgreSQL, or address 16/main.
readonly PG_VERSION="16"
readonly CLUSTER="jhcnetops"
readonly PORT="5433"
readonly DATABASE="jhc_netops"
readonly OWNER_ROLE="jhc_netops_owner"
readonly APP_ROLE="jhc_netops_app"
readonly EXPECTED_DATA_ROOT="/var/lib/postgresql/${PG_VERSION}/${CLUSTER}"

fail() { printf 'JHC NetOps PostgreSQL application provisioning error: %s\n' "$1" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || fail "run as root during an approved provisioning window"
command -v pg_lsclusters >/dev/null || fail "pg_lsclusters is unavailable"

cluster_line="$(pg_lsclusters --no-header | awk -v version="${PG_VERSION}" -v cluster="${CLUSTER}" '$1 == version && $2 == cluster { print $3 ":" $4 }')"
[[ -n "${cluster_line}" ]] || fail "dedicated cluster ${PG_VERSION}/${CLUSTER} does not exist"
[[ "${cluster_line%%:*}" == "${PORT}" ]] || fail "dedicated cluster is not on port ${PORT}"
[[ "${cluster_line#*:}" == "online" ]] || fail "dedicated cluster is not online"

psql_cluster=(runuser -u postgres -- psql --cluster "${PG_VERSION}/${CLUSTER}" --set ON_ERROR_STOP=1 --no-psqlrc --tuples-only --no-align)
data_directory="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW data_directory')"
listen_addresses="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW listen_addresses')"
runtime_port="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW port')"
config_file="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW config_file')"
hba_file="$("${psql_cluster[@]}" --dbname postgres --command 'SHOW hba_file')"
[[ "${data_directory}" == "${EXPECTED_DATA_ROOT}" ]] || fail "unexpected dedicated data directory"
[[ "${listen_addresses}" == "127.0.0.1" ]] || fail "dedicated cluster must listen only on 127.0.0.1"
[[ "${runtime_port}" == "${PORT}" ]] || fail "dedicated runtime port is not ${PORT}"
[[ "${config_file}" == "/etc/postgresql/${PG_VERSION}/${CLUSTER}/postgresql.conf" ]] || fail "unexpected dedicated configuration file"
[[ "${hba_file}" == "/etc/postgresql/${PG_VERSION}/${CLUSTER}/pg_hba.conf" ]] || fail "unexpected dedicated HBA file"

"${psql_cluster[@]}" --dbname postgres <<SQL
DO \$provision\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
    CREATE ROLE ${OWNER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END
\$provision\$;
SQL

unsafe_roles="$("${psql_cluster[@]}" --dbname postgres --command "SELECT rolname FROM pg_roles WHERE rolname IN ('${OWNER_ROLE}', '${APP_ROLE}') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)")"
[[ -z "${unsafe_roles}" ]] || fail "a NetOps role has elevated cluster privileges"
owner_can_login="$("${psql_cluster[@]}" --dbname postgres --command "SELECT rolcanlogin FROM pg_roles WHERE rolname = '${OWNER_ROLE}'")"
[[ "${owner_can_login}" == "f" ]] || fail "owner role must remain NOLOGIN"
app_memberships="$("${psql_cluster[@]}" --dbname postgres --command "SELECT count(*) FROM pg_auth_members membership JOIN pg_roles member ON member.oid = membership.member WHERE member.rolname = '${APP_ROLE}'")"
[[ "${app_memberships}" == "0" ]] || fail "runtime app role must not inherit another role"

database_owner="$("${psql_cluster[@]}" --dbname postgres --command "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DATABASE}'")"
if [[ -z "${database_owner}" ]]; then
  runuser -u postgres -- createdb --cluster "${PG_VERSION}/${CLUSTER}" --owner "${OWNER_ROLE}" "${DATABASE}"
elif [[ "${database_owner}" != "${OWNER_ROLE}" ]]; then
  user_table_count="$("${psql_cluster[@]}" --dbname "${DATABASE}" --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
  [[ "${user_table_count}" == "0" ]] || fail "existing database has user tables and an unexpected owner"
  "${psql_cluster[@]}" --dbname postgres --command "ALTER DATABASE ${DATABASE} OWNER TO ${OWNER_ROLE}"
fi

"${psql_cluster[@]}" --dbname postgres <<SQL
REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${DATABASE} TO ${APP_ROLE};
SQL

printf '%s\n' \
  "Dedicated NetOps owner/app roles and database contract are reconciled." \
  "No password was accepted or printed; the app role remains NOLOGIN if newly created." \
  "Set its password interactively, then ALTER ROLE ${APP_ROLE} LOGIN before runtime acceptance."
