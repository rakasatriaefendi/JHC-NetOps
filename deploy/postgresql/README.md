# Dedicated JHC NetOps PostgreSQL cluster

> **Runtime source saat ini:** PostgreSQL lokal, Local Auth, dan local SSE menjadi
> authority; P18 menambahkan control WebSocket dan monitoring berbasis presence.
> P12/P13/P15 di bawah dipertahankan sebagai riwayat cutover, bukan konfigurasi
> authority alternatif.

## Panduan memilih prosedur

| Tujuan operator | Baca / lakukan |
| --- | --- |
| Memahami database runtime saat ini | [Backend README](../../backend/README.md) dan [index migration 001–019](../../backend/migrations/README.md) |
| Update source P18 pada schema yang sudah memenuhi prasyarat | [P18 rollout dan acceptance](../../docs/P18_ZERO_IDLE.md); P18 sendiri tidak membuat migration |
| Provision host baru atau disaster recovery | Review prosedur cluster/role/backup di dokumen ini; jangan mengeksekusi ulang baseline pada host existing |
| Menguji read-only preflight | Gunakan bagian P11 preflight yang menunjuk immutable candidate; ini bukan full P18 acceptance |
| Menelusuri rehearsal/cutover lama | Runbook P12/P13 beserta evidence; bukan operasi rutin release berikutnya |

Schema version yang aktif harus diverifikasi operator pada lingkungan tujuan;
paragraf fondasi 001–006 di bawah menjelaskan fase awal P10/P11, bukan klaim bahwa
source sekarang hanya memerlukan enam migration. Migrations tetap operator-run;
startup backend dapat melakukan job recovery/config bootstrap meski tidak
menjalankan schema migration, sehingga startup candidate ke DB live bukan uji
read-only.

Identitas dedicated tetap database `jhc_netops`, cluster `16/jhcnetops`, port
`5433`, data directory `/var/lib/postgresql/16/jhcnetops`, owner
`jhc_netops_owner` (`NOLOGIN`), dan runtime `jhc_netops_app`. Sesi administratif
menggunakan `postgres`, termasuk peer-authenticated Unix socket yang diterima
guard migration 007/008 jika seluruh identitas exact cocok. Browser tidak pernah
memegang DSN. Jangan mengubah cluster `16/main:5432` atau role/database proyek lain.

Contoh provisioning GitHub Actions hanya untuk runner CI ephemeral. Role/privilege
test tidak boleh disalin sebagai konfigurasi production.


These files are the reviewed provisioning/recovery path for the established
foundation. They are **not** executed by the application or by repository tests.

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

## P10/P11 foundation state (historical)

The operator has already created `16/jhcnetops` on port 5433 and established the
local migrations `001`-`006`. Do **not** recreate that cluster or reapply the
baseline merely for P11 verification. The cluster script detects the existing
cluster, verifies its dedicated name/port, prints a no-change result, and exits.
It never edits an existing cluster. Provisioning and migration commands below
are retained for reviewed disaster recovery/new-host procedures, not routine
P11 candidate acceptance.

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

The wrapper applies established migrations `001` through `006` in order. They
remain inside schema `asset` and do not connect to or alter `16/main`.

The runtime application role has no superuser, database-create, role-create,
replication, bypass-RLS, or inherited-role privilege. The NOLOGIN schema owner is
separate. Runtime receives only database CONNECT, schema USAGE, and CRUD on the
`asset` schema objects required by later P10D ingestion; it receives no access to
another database or schema.

## Verification layers

### Layer 1 Ã¢â‚¬â€ Application Connection Preflight

Perform read-only acceptance with the application role. `psql` prompts for the
password and the commands do not print it:

```bash
psql --host 127.0.0.1 --port 5433 --username jhc_netops_app \
  --dbname jhc_netops --set ON_ERROR_STOP=1 \
  --command "SELECT current_database(), current_user, inet_server_port();" \
  --command "SELECT count(*) AS asset_count FROM asset.assets;" \
  --command "SELECT has_schema_privilege(current_user, 'asset', 'USAGE') AS asset_usage;"
```

The repository-managed P11 equivalent additionally validates the complete
baseline and uses the runtime DSN guard. For candidate acceptance, run the
preflight from the immutable candidate release, not from `current`:

```bash
ROOT=/var/www/jhc/jhc_noc
SHA=<CANDIDATE_SHA>
REL="$ROOT/releases/$SHA"

cd "$REL/backend"
set -a
. "$ROOT/shared/backend/.env"
set +a
npm run preflight:postgres
unset DATABASE_URL
```

Candidate preflight must execute code from `releases/<CANDIDATE_SHA>` while
`current` remains on the previously accepted live release. The shared backend
environment may still point candidate and live at the same database, so this
preflight must remain read-only. It executes only `SELECT`; it never applies the
migration wrapper or repairs missing objects. This candidate procedure does not
alter the final live release or `current` symlink workflow.

### Layer 2 Ã¢â‚¬â€ Host/Cluster Operator Verification

Separately, an authorized operator verifies that cluster `16/jhcnetops` is
online on port `5433`, uses data directory
`/var/lib/postgresql/16/jhcnetops`, has loopback-only PostgreSQL configuration,
and maps to the expected physical service/configuration files. These checks are
host-level checks and are not forced through the unprivileged
`jhc_netops_app` connection. They must not target or restart `16/main`.

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
Application rollback is to stop NetOps, restore the reviewed environment/release,
and restart only NetOps. A symlink/release rollback does not roll back database
schema or data. Do not delete the cluster and do not touch `16/main`; any future
database rollback requires a separate reviewed data-compatible plan.

Migration `006_medical_equipment.sql` is included in the reviewed aggregate
script for P10F. It is additive and targets only the dedicated `jhc_netops`
database on port 5433. Never apply it to PostgreSQL `16/main`; the reviewed
future rollout/recovery procedure remains in
`../../docs/P10F_MEDICAL_EQUIPMENT.md`.

## P15.3 shadow-projection retirement

Migration `015_retire_shadow_projection.sql` stops new Supabase shadow-outbox
production after local PostgreSQL persistence and local NOTIFY/SSE have become
authoritative. It validates and drops exactly the 16 `shadow_*` triggers created
by migration 008. It does not drain or rewrite the existing backlog, drop the
enqueue function, alter domain tables, or touch any `local_realtime_*` trigger.

Historical remote credentials are not part of the active release or environment.
Retain only protected offline rollback evidence until P16.4 acceptance. Do not
remove historical outbox/watermarks or the remote project during P16.3.
Apply the immutable candidate migration only during the approved NetOps change
window, with the NetOps backend stopped and the exact dedicated cluster named:

```bash
ROOT=/var/www/jhc/jhc_noc
SHA=<FULL_40_CHARACTER_CANDIDATE_SHA>
REL="$ROOT/releases/$SHA"

sudo -u postgres psql --cluster 16/jhcnetops --dbname jhc_netops \
  --file "$REL/backend/migrations/015_retire_shadow_projection.sql"
```

Run these read-only checks before migration and retain their output as PRE
evidence. The trigger query must return exactly the reviewed 16 rows; record the
outbox counts and `max_id` for the POST comparison.

```sql
SELECT version, applied_at
FROM public.application_schema_migrations
ORDER BY version;

SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pn.nspname || '.' || p.proname AS trigger_function, t.tgenabled
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS cn ON cn.oid = c.relnamespace
JOIN pg_proc AS p ON p.oid = t.tgfoid
JOIN pg_namespace AS pn ON pn.oid = p.pronamespace
WHERE NOT t.tgisinternal
  AND cn.nspname = 'public'
  AND (left(t.tgname, 7) = 'shadow_'
       OR (pn.nspname = 'public' AND p.proname = 'enqueue_realtime_shadow'))
ORDER BY c.relname, t.tgname;

SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE status = 'pending') AS pending_rows,
       count(*) FILTER (WHERE status = 'failed') AS failed_rows,
       count(*) FILTER (WHERE status = 'delivered') AS delivered_rows,
       max(id) AS max_id
FROM public.realtime_outbox;
```

Immediately after migration, use the following read-only checks. Version 15
must exist, the shadow query must return zero rows, the local trigger inventory
must remain populated, and the outbox counts/`max_id` must exactly equal PRE
evidence.

```sql
SELECT version, applied_at
FROM public.application_schema_migrations
WHERE version IN (14, 15)
ORDER BY version;

SELECT c.relname AS table_name, t.tgname AS trigger_name
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND left(t.tgname, 7) = 'shadow_'
ORDER BY c.relname, t.tgname;

SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND left(t.tgname, 15) = 'local_realtime_'
ORDER BY c.relname, t.tgname;

SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE status = 'pending') AS pending_rows,
       count(*) FILTER (WHERE status = 'failed') AS failed_rows,
       count(*) FILTER (WHERE status = 'delivered') AS delivered_rows,
       max(id) AS max_id
FROM public.realtime_outbox;
```

After deploying the P15.3 application and allowing normal runner/telemetry
activity for at least 30-60 seconds, run the no-growth proof below. `max_id`
must still equal PRE/POST migration evidence, runner timestamps must be fresh,
and local realtime triggers must remain enabled.

```sql
SELECT count(*) AS total_rows, max(id) AS max_id
FROM public.realtime_outbox;

SELECT id, health_status, last_seen_at, clock_timestamp() - last_seen_at AS heartbeat_age
FROM public.diagnostic_runners
ORDER BY id;

SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
FROM pg_trigger AS t
JOIN pg_class AS c ON c.oid = t.tgrelid
JOIN pg_namespace AS n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND left(t.tgname, 15) = 'local_realtime_'
ORDER BY c.relname, t.tgname;
```

Rolling application code back to P15.2 can restore application correctness,
but it cannot by itself restore shadow projection: migration 015 has retired
the producer triggers. Restoring shadow projection is a separate reviewed
database change that must recreate the exact migration-008 trigger inventory,
validate preserved outbox/watermark evidence and use the separately archived,
reviewed rollback release and credentials. Current source contains no projector. Never claim that a symlink
rollback alone re-enables shadow production, and never purge historical rows as
part of either rollback.
