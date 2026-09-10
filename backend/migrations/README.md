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
Apply migrations through the reviewed
wrapper in `deploy/postgresql/apply-asset-migration.sql` during an approved change
window; no migration is run automatically at backend startup.
