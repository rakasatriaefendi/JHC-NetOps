# Local PostgreSQL migrations

These migrations apply only to the dedicated `jhc_netops` database in the
PostgreSQL `16/jhcnetops` cluster on port 5433. They must never be applied to
PostgreSQL `16/main`, `mercure`, `montblanc`, or Supabase.

Migrations are forward-only and non-destructive. `002_asset_intelligence.sql`
adds the P10D1 stable source key and bounded normalized evidence fields; it does
not add P10D2 identity/history tables. `003_active_inventory_scan.sql` adds the
`active_scan` source and bounded lifecycle metadata only; raw XML is excluded.
`004_asset_change_history.sql` adds append-only, normalized `created` and grouped
`changed` events. It performs no historical backfill and stores no raw scanner
payloads or credentials. `005_scan_network_settings.sql` adds the durable,
soft-deletable RFC1918 scan allowlist and one-time environment bootstrap marker;
live route state remains derived and no existing assets or scan runs are rewritten.
`006_medical_equipment.sql` adds the operational medical registry, one-to-one
optional network-asset linkage, SQL DATE calibration/service histories, and
concurrency-safe record-number sequences. It does not copy IP/MAC identity or
create network activity.

`007_application_persistence.sql` is the separate P13 application-table schema
promoted from the reviewed P12 rehearsal schema. It is **not** part of the Asset
migration wrapper or backend startup. After a separately approved P13 change
window, the operator must explicitly run the immutable release file with
`psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -d jhc_netops -f
"$REL/backend/migrations/007_application_persistence.sql"` using the reviewed
owner role. Its transaction guards the database/cluster identity and records
schema version 7; it does not create local Auth or Realtime schemas.

`008_application_persistence_outbox.sql` is the separate P13 Batch 5 schema
for the transactional Realtime shadow outbox, per-aggregate projection
watermarks, and bounded internal cutover canary. It requires recorded version
7, records version 8, leaves `asset.*` unchanged, and is likewise operator-run
only during an approved P13 window.

`009_local_realtime_invalidation.sql` adds the P14 invalidation-only
`pg_notify` function and bounded Network Health trigger surface. It records
version 9 without removing or changing the P13 outbox or shadow projector and
is also applied only by an operator during an approved change window.

`010_diagnostics_device_inspector_realtime.sql` additively extends the same
bounded local notification channel with invalidation-only Diagnostics and
Device Inspector topics. It records version 10, leaves migration 009 and its
Network Health triggers intact, and does not alter the P13 outbox or shadow
projector.

`011_local_auth.sql` adds local password credentials and opaque session-token
digests bound one-to-one to existing `profiles` identities. It stores no role or
approval state; `profiles` remains the sole authorization authority. The migration
does not modify migration 010, realtime triggers, the outbox, Traffic, or `asset.*`.

`012_fix_local_realtime_control_trigger.sql` repairs the existing Diagnostics and
Device Inspector trigger function without changing its topic or table scope.

`013_traffic_realtime.sql` additively publishes invalidation-only Traffic events
for `traffic_live_sessions` and `traffic_live_snapshots`, keyed by `runner_id`.
It requires migration 12 and leaves capture, outbox, shadow projection, and all
earlier local realtime triggers unchanged.

`014_managed_telemetry_realtime.sql` additively publishes invalidation-only
Managed Telemetry events for the three latest-state tables used live by Device
Profile, keyed by their common `target_id`. It requires migration 13 and does
not add realtime behavior to Managed Telemetry events or server-snapshot pages.

`015_retire_shadow_projection.sql` is the P15.3 final shadow-projection
retirement. It requires migration 14, validates the exact 16 migration-008
producer triggers, and drops only those triggers. Historical
`realtime_outbox`/`realtime_projection_watermarks` rows, the enqueue function,
domain tables, and all migration 009-014 local `pg_notify` triggers remain
unchanged. The local backend no longer runs a Supabase shadow projector after
this migration; no backlog drain or cosmetic delivery update is performed.

`016_admin_user_lifecycle.sql`
requires recorded version 15 and the exact dedicated cluster guards. It adds
explicit Disabled profile metadata, preserves Discovery/Inspector history with
nullable `requested_by` SET NULL FKs, and adds append-only account lifecycle audit
identities (no profile FKs; runtime SELECT/INSERT only). It does not disable,
delete, approve, or enroll any existing account. Apply 016 explicitly before
starting the P17.1 application release; migrations 001-015 remain unchanged.

`017_administrative_audit.sql` requires version 16 as the latest prerequisite on
the exact dedicated cluster. It adds append-only, fixed-schema Report Branding
audit summaries (Admin actor UUID, allowlisted action/resource and safe before/
after identity/logo availability). Runtime can SELECT/INSERT, never UPDATE/DELETE;
there are no profile/resource FKs. Existing lifecycle audit remains separate.
Apply 017 explicitly before enabling this source release; startup never migrates.
Migrations 001-016 remain immutable.

Apply Asset migrations through the reviewed
wrapper in `deploy/postgresql/apply-asset-migration.sql` during an approved change
window; no migration is run automatically at backend startup.

The wrapper is explicit, reviewed, manually invoked, and fail-fast. Always name
cluster `16/jhcnetops` and database `jhc_netops`; never rely on the default
cluster and never target `16/main`/port `5432`. P11 read-only acceptance uses
`npm run preflight:postgres` and does not execute this wrapper.

Application symlink rollback is not database rollback. Once schema or data has
changed, retain it unless a separate reviewed database rollback plan confirms
compatibility and exact targets. The legacy guarded rollback file is only for an
empty pre-use Asset schema and is not a general migration rollback mechanism.
