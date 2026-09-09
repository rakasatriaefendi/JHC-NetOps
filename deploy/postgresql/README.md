# Dedicated JHC NetOps PostgreSQL cluster

These files are a reviewed future provisioning path. They are **not** executed by
the application or by repository tests.

## Isolation invariant

- PostgreSQL `16/main`, port `5432`, and its `mercure`/`montblanc` databases are
  outside JHC NetOps scope and must never be changed.
- JHC NetOps uses only PostgreSQL `16/jhcnetops`, port `5433`, database
  `jhc_netops`, owner role `jhc_netops_owner`, and application role
  `jhc_netops_app`.
- The dedicated cluster listens only on loopback and owns separate data,
  `postgresql.conf`, `pg_hba.conf`, roles, and database catalog.
- Only the local Fastify backend connects. The Next.js browser bundle never
  receives the PostgreSQL connection string.

## Current pre-migration state

The operator has already created and started `16/jhcnetops` on port 5433 with
loopback-only listening and an empty `jhc_netops` database. Do **not** recreate
that cluster. The cluster script now detects this state, verifies the dedicated
name/port, prints a no-change result, and exits. It never edits an existing
cluster. Use the application provisioning script for roles and database grants.

## Approved acceptance procedure

Stop the NetOps processes first. Do not stop or restart `postgresql@16-main`.

```bash
cd /var/www/jhc/jhc_noc/current
sudo bash deploy/postgresql/provision-jhcnetops-cluster.sh
sudo bash deploy/postgresql/provision-jhcnetops-application.sh
sudo -u postgres psql --cluster 16/jhcnetops -d postgres
```

At the interactive `psql` prompt, set a generated password without putting it in
shell history:

```text
\password jhc_netops_app
ALTER ROLE jhc_netops_app LOGIN;
\q
```

Then apply the reviewed migration from the repository root:

```bash
sudo -u postgres psql --cluster 16/jhcnetops --dbname jhc_netops \
  --file deploy/postgresql/apply-asset-migration.sql
```

The runtime application role has no superuser, database-create, role-create,
replication, bypass-RLS, or inherited-role privilege. The NOLOGIN schema owner is
separate. Runtime receives only database CONNECT, schema USAGE, and CRUD on the
`asset` schema objects required by later P10D ingestion; it receives no access to
another database or schema.

Perform read-only acceptance with the application role. `psql` prompts for the
password and the commands do not print it:

```bash
psql --host 127.0.0.1 --port 5433 --username jhc_netops_app \
  --dbname jhc_netops --set ON_ERROR_STOP=1 \
  --command "SELECT current_database(), current_user, inet_server_port();" \
  --command "SELECT count(*) AS asset_count FROM asset.assets;" \
  --command "SELECT has_schema_privilege(current_user, 'asset', 'USAGE') AS asset_usage;"
```

Optionally run the repository integration test only after explicitly loading the
protected backend environment. It runs sessions with
`default_transaction_read_only=on`, is outside the normal test glob, and refuses
all hosts except `jhc_netops_app@127.0.0.1:5433/jhc_netops`:

```bash
cd /var/www/jhc/jhc_noc/current/backend
set -a
. /var/www/jhc/jhc_noc/shared/backend/.env
set +a
P10C_POSTGRES_TEST_OPT_IN=1 P10C_TEST_DATABASE_URL="$DATABASE_URL" npm run test:postgres:assets
unset P10C_TEST_DATABASE_URL DATABASE_URL
```

If migration acceptance fails **before any production asset is written**, the
migration itself rolls back atomically. If a completed empty schema must be
removed, first stop NetOps, verify the asset count is zero, then run the guarded
rollback. It refuses another database and refuses a non-empty asset table:

```bash
cd /var/www/jhc/jhc_noc/current
sudo -u postgres psql --cluster 16/jhcnetops --dbname jhc_netops \
  --file deploy/postgresql/rollback-p10c-before-use.sql
```

This rollback drops only `asset.*`; it does not delete the database, roles,
cluster, or any Supabase data. Never adapt it to `16/main`.

Place the resulting DSN and a separate frontend-to-backend token only in the
permission-restricted shared backend environment file. Put the matching frontend
token only in the server-side frontend environment; neither variable is
`NEXT_PUBLIC_*`. Never paste real values into Git.

```text
DATABASE_URL=postgresql://jhc_netops_app:<password>@127.0.0.1:5433/jhc_netops
FRONTEND_API_TOKEN=<separate random server-to-server token>
LOCAL_BACKEND_URL=http://127.0.0.1:3402
LOCAL_BACKEND_FRONTEND_TOKEN=<same frontend server-to-server token>
```

Start `postgresql@16-jhcnetops`, the backend, and then the frontend. Verify
`/healthz`, Asset Inventory, and the unchanged recurring runner data plane.
Rollback is to stop NetOps, remove the four P10C environment entries, and restart
the prior NetOps release. Do not delete the cluster during rollback and do not
touch `16/main`.
