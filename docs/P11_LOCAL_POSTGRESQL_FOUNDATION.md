# P11 Local PostgreSQL Foundation

> **Historical P11 foundation record:** this file documents the pre-cutover state and is retained as migration evidence. Current P16 runtime is local-only; use the root README and HANDOVER for operations.


This document is the persistence source of truth for P11. P11 hardens and
verifies the existing local PostgreSQL foundation; it does not copy Supabase
data or change persistence authority.

## Dedicated database identity

JHC NetOps owns only this PostgreSQL target:

| Property | Required value |
|---|---|
| Cluster | `16/jhcnetops` |
| Port | `5433` |
| Database | `jhc_netops` |
| Owner role | `jhc_netops_owner` (`NOLOGIN`) |
| Runtime role | `jhc_netops_app` |
| Data directory | `/var/lib/postgresql/16/jhcnetops` |
| Listener | loopback only |

PostgreSQL `16/main` on port `5432`, including `mercure` and `montblanc`, is
owned by other projects and is always outside NetOps scope. NetOps scripts must
name `--cluster 16/jhcnetops`, `--dbname jhc_netops`, and fail fast. The browser
never receives `DATABASE_URL`; only the loopback Fastify backend connects. The
dedicated cluster has its own data directory, `postgresql.conf`, `pg_hba.conf`,
roles, and database catalog.

Persistence-related environment names are `DATABASE_URL`, `FRONTEND_API_TOKEN`,
`LOCAL_BACKEND_URL`, `LOCAL_BACKEND_TOKEN`, `LOCAL_BACKEND_FRONTEND_TOKEN`,
`REPORT_BRANDING_DIR`, `MEDICAL_DUE_SOON_DAYS`, and `ASSET_SCAN_NETWORKS`.
Supabase remains configured through `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Values belong only in protected environment
files and must never be printed or committed.

## Persistence authority inventory

"Uses the local backend" does **not** mean "uses local PostgreSQL". The P10B
runner routes are local transport, but their repositories still persist to
Supabase.

| Domain | Current authority | Realtime/Auth dependency | Future phase |
|---|---|---|---|
| Asset Inventory, evidence, active scan, change history | Local PostgreSQL `asset.*`; normalized evidence is still read from Supabase | Supabase evidence and user Auth | P13 removes remaining DB coupling; P15 replaces Auth |
| Scan Network Settings | Local PostgreSQL `asset.scan_networks` and bootstrap state | Supabase user Auth | P15 |
| Medical Equipment and calibration/service history | Local PostgreSQL `asset.*` | Supabase user Auth | P15 |
| Asset Excel report data | Local PostgreSQL | Supabase user Auth | P15 |
| Report branding | Local filesystem `REPORT_BRANDING_DIR` | Supabase user Auth | P15; filesystem remains separately backed up |
| Profiles, role and approval | Supabase Database | Supabase Auth/RLS | P13/P15 |
| Runner heartbeat | Supabase `diagnostic_runners` through local backend | Supabase Database and Realtime | P13/P14 |
| Health Watch | Supabase targets/latest/samples/events through local backend | Supabase Database, Realtime; Manual Ping Edge control plane | P13/P14 |
| Traffic metrics, flows and live sessions | Supabase tables/RPCs through local backend or retained Edge paths | Supabase Database and Realtime | P13/P14 |
| LAN Diagnostics | Supabase jobs, bandwidth and hop measurements | Supabase Database, Edge Functions and Realtime | P13/P14 |
| Network Discovery | Supabase session state | Supabase Database, Edge Functions and Realtime | P13/P14 |
| Device Inspector | Supabase inspection sessions and `network_nodes` evidence | Supabase Database, Edge Functions and Realtime | P13/P14 |
| Network inventory identity | Supabase `network_nodes` and target tables | Supabase Database, RLS and Auth | P13/P15 |
| Managed SNMP Telemetry and Observed LAN Hosts | Supabase targets/latest/interface/observed-host/event tables through local backend | Supabase Database and Realtime | P13/P14 |
| Alerts/events | Supabase `events` | Supabase Database and Realtime | P13/P14 |

Current Realtime subscriptions include `diagnostic_runners`, `diagnostic_jobs`,
`network_discovery_sessions`, `device_inspection_sessions`,
`traffic_live_sessions`, `traffic_live_snapshots`, `network_targets`,
`network_health_latest`, `network_health_ping_jobs`, `events`,
`managed_device_latest`, `managed_interface_latest`, and
`managed_observed_hosts_latest`. P11 does not replace them.

Supabase Auth remains authoritative for sign-in/up/out, sessions/cookies,
claims, `profiles.role`, approval status, RLS, admin RPCs, and Edge Function user
authorization. P11 does not replace Auth.

## Established local baseline

Migrations `001` through `006` in `backend/migrations/` are the established
local baseline. They cover assets, intelligence evidence, active scan runs,
change history, scan-network settings, and Medical Equipment. P11 neither
recreates them nor adds Supabase-copy schemas.

SQL migrations are reviewed, explicit, manually invoked, and fail-fast. Backend
startup never runs schema migrations or Supabase backfills. Startup may perform
application metadata work, specifically scan-network bootstrap and interrupted
scan recovery, after the schema already exists; those operations are not schema
migrations.

## Verification layers

### Layer 1 Ã¢â‚¬â€ Application Connection Preflight

Run from `backend/` only after loading the protected backend environment:

```bash
npm run preflight:postgres
```

The command uses the same fail-closed `DATABASE_URL` validator as runtime and a
single connection with `default_transaction_read_only=on`. It performs only
`SELECT` statements and verifies:

- database `jhc_netops`, role `jhc_netops_app`, port `5433`, and loopback;
- the session is read-only;
- tables and sequences established by migrations `001`-`006` exist.

Layer 1 runs with the unprivileged `jhc_netops_app` role. It deliberately does
not request privileged server configuration such as `data_directory`.

It does not create, alter, drop, insert, update, delete, truncate, seed, repair,
apply migrations, or import data. Output contains identity/status only and never
prints the DSN or password. Failure is terminal and does not fall back to a
default PostgreSQL target.

### Layer 2 Ã¢â‚¬â€ Host/Cluster Operator Verification

An operator separately verifies the physical PostgreSQL service: cluster
`16/jhcnetops`, port `5433`, online state, data directory
`/var/lib/postgresql/16/jhcnetops`, loopback-only configuration, and the exact
service/configuration identity. These host checks are not forced through
`jhc_netops_app` and are not performed by the Layer 1 application preflight.
They must never target or restart `16/main`.

## P12/P13 data-preservation contract

Future rehearsal and cutover must preserve and verify:

- original UUIDs, primary/foreign keys, relationship order, and null semantics;
- creation/update/measurement timestamps and timezone meaning;
- JSON/JSONB, `inet`, `macaddr`, enum/check, array, and native PostgreSQL types;
- unique constraints, idempotency/event keys, and sequence/identity positions;
- `first_seen`/`last_seen`, current/stale, latest-state/history, and resolution semantics;
- queued/running jobs, leases, locks, active sessions, and a defined cutover checkpoint;
- event ordering and deduplication;
- Asset Inventory source keys and evidence reconciliation without duplicate assets;
- row counts per table, FK/orphan checks, latest/history relationships, and representative record comparisons;
- restartable copy checkpoints and post-copy verification before authority changes;
- rollback boundaries and prevention of split-brain or unreviewed dual-write.

P12 is a schema/data migration rehearsal. P13 changes application database
authority only after a successful rehearsal. P14 replaces Realtime, P15 replaces
Auth, and P16 decommissions Supabase and completes handover. These phases must
remain separate.

## Candidate and rollback safety

Candidate frontend/backend ports (`3411`/`3412`) are process isolation only;
live uses frontend/backend ports (`3401`/`3402`). A candidate may load the same
shared backend environment as live, so **port isolation is not database
isolation**.

P11 candidate acceptance may use builds, tests, static/config validation,
source/artifact verification, `/healthz`, and the read-only foundation preflight.
It must not apply migrations, seed, backfill, reconcile writes, switch database
authority, or mutate production application rows.

An application symlink rollback changes code only. It does not reverse a schema
or data migration. Database rollback therefore requires its own reviewed
checkpoint and compatibility decision; never assume switching `current` reverts
PostgreSQL state.
