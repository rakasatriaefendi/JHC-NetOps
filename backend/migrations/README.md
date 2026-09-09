# Local PostgreSQL migrations

These migrations apply only to the dedicated `jhc_netops` database in the
PostgreSQL `16/jhcnetops` cluster on port 5433. They must never be applied to
PostgreSQL `16/main`, `mercure`, `montblanc`, or Supabase.

Migrations are forward-only and non-destructive. `002_asset_intelligence.sql`
adds the P10D1 stable source key and bounded normalized evidence fields; it does
not add P10D2 identity/history tables. Apply migrations through the reviewed
wrapper in `deploy/postgresql/apply-asset-migration.sql` during an approved change
window; no migration is run automatically at backend startup.
