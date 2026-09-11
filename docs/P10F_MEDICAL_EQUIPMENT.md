# P10F Medical Equipment

P10F adds an operational medical-equipment registry to the existing local Asset
Management boundary. It is source-complete but is not deployed until an operator
performs the dedicated runtime acceptance below.

## Data and semantics

- `asset.medical_equipment` stores equipment identity, department/location,
  operational status, intervals, notes, and an optional `network_asset_id`.
- A partial unique index enforces at most one medical record per canonical
  network asset. `ON DELETE SET NULL` preserves the medical record.
- IP and MAC are never copied into the medical table. Asset Inventory remains
  authoritative for current network identity.
- Operational status (`active`, `in_maintenance`, `out_of_service`, `retired`)
  is independent from reachability and monitoring state.
- Calibration and service values use PostgreSQL `date`. Latest records derive
  due states at read time; P10F adds no scheduler or background job.
- `MEDICAL_DUE_SOON_DAYS` is bounded to 1–180 and defaults to 30.
- Human record identifiers use independent database sequences:
  `CAL-YYYY-######` and `SRV-YYYY-######`.

## Security and API

The browser never connects to PostgreSQL or Fastify directly. Protected Next.js
Server Components and actions use `LOCAL_BACKEND_FRONTEND_TOKEN` against the
loopback-only backend. Backend routes independently verify that token, strictly
allowlist body/query fields, cap pages, histories, and searches, use bounded
deadlines, and return sanitized errors. Approved viewers may read. Only
Operator/Admin server actions may mutate. A browser-supplied role is never used.

Routes:

- `GET/POST /api/medical-equipment`
- `GET/PATCH /api/medical-equipment/:id`
- `POST /api/medical-equipment/:id/calibrations`
- `POST /api/medical-equipment/:id/services`
- `GET /api/medical-equipment/network-assets?q=...`
- `GET /api/medical-equipment/network-links?asset_ids=...`

## UI

`/medical-equipment` provides summaries, server-side search/filters, pagination,
responsive table/cards, and the add flow. `/medical-equipment/<id>` has Overview,
Calibration, Maintenance & Service, and Network Context tabs. Date assistance
uses calendar-month arithmetic and remains editable. Certificate entry supports
free text or guided prefix/year/sequence input without a hardcoded organization
prefix and preserves leading zeros. Asset Detail resolves reverse medical links
with one bounded batch request.

## Prepared runtime acceptance (not executed)

1. Record the release and back up the dedicated `16/jhcnetops` database. Verify
   the DSN targets port 5433, never shared `16/main` on 5432.
2. Stop only reviewed NetOps processes; do not stop unrelated PostgreSQL
   clusters or services.
3. Apply `deploy/postgresql/apply-asset-migration.sql` as the dedicated NetOps
   owner against `jhc_netops`. Verify migration 006 objects and grants, then
   restart only NetOps backend/frontend.
4. Confirm Viewer read-only and Operator/Admin mutations. Create one clearly
   marked acceptance fixture, one calibration, and one service record.
5. Verify due states around yesterday/today/threshold+1, certificate leading
   zeros, duplicate equipment code, and duplicate network link rejection.
6. Verify desktop/mobile registry and detail, both languages, and Asset Detail
   reverse linkage. Confirm no scan, SNMP poll, or other network action occurs.
7. Remove only the recorded fixture IDs. Confirm existing assets, telemetry,
   reports, and other PostgreSQL databases are unchanged.

Rollback is application-first: stop only NetOps services and return to the
previous release. Migration 006 is additive; do not drop tables automatically.
Retain data for diagnosis or remove it only through a separately reviewed,
explicit operator plan.
