# P10E Asset Reporting / Excel Export

P10E adds an on-demand, server-generated Excel report to the existing Asset
Inventory. It does not introduce another inventory model: the dedicated local
PostgreSQL `asset.assets` rows and P10D `asset.change_events` remain authoritative.

## Portable report branding

Report identity is runtime configuration, not product code. An Admin can set an
institution name, optional division, and PNG/JPEG logo in **Admin -> Report
Branding**. The neutral state is `JHC NetOps`, no division, and no logo. The
backend stores only bounded non-secret branding metadata and a canonical logo
file in `REPORT_BRANDING_DIR`; the browser never receives this filesystem path.

Local development defaults to ignored `backend/data/report-branding`. Production
must set `REPORT_BRANDING_DIR=/var/www/jhc/jhc_noc/shared/branding` in the
server-only backend environment so branding survives release changes. Writes use
temporary files followed by atomic rename. PNG and JPEG are the only accepted
formats; extension, MIME, magic bytes, dimensions, and the **10 MiB** limit are
validated. Missing, unreadable, or malformed branding falls back safely and does
not block report generation.

Each export reads one branding snapshot. The Summary header embeds the logo at a
bounded aspect ratio and renders institution, optional division, and the
localized report-owned title. It never depends on an external image URL.

## Operator workflow and contract

From `/assets`, an approved user may use either the header action or bottom
report CTA after applying the existing search, device type,
vendor, OS/platform, status, and name-sort controls, then select **Ekspor Excel**
or **Export Excel**. The browser calls a protected Next.js route; that server
route forwards only the allowlisted criteria to the loopback Fastify backend.
The backend token never reaches browser code. UI `page` and `page_size` are
deliberately excluded, so the workbook contains all matching rows within the
documented bound rather than only the visible page.

The generated file is named
`JHC-NetOps-Asset-Inventory-YYYY-MM-DD.xlsx`, returned with the XLSX MIME type,
not stored on disk, and contains:

- **Summary / Ringkasan**: generation time, active criteria, matching/exported
  counts, localized status/device-type counts, vendor/OS completeness, explicit
  limit state, and high-contrast section headers.
- **Assets / Aset**: safe identity, current addressing, classification,
  evidence, timestamps, ports/services, and Yes/No SNMP and Health Watch
  linkage. It does not run Device Inspector or infer availability during export.
- **Change History / Riwayat Perubahan**: newest-first created/meaningful-change
  events belonging only to the exported asset IDs. Before/After values are
  readable summaries, not raw JSON.

Operational `status` churn is not Asset Change History. Legacy status-only rows
are excluded and `status` is removed from mixed-event changed fields while the
existing snapshot remains readable for context.

## Bounds and security

- maximum assets: **2,000**;
- maximum history events: **10,000**;
- maximum generated response: **20 MiB**;
- backend persistence/report deadline: **12 seconds**;
- one bounded asset query, one count query, and one history query scoped by the
  exported asset IDs, in a read-only repeatable-read transaction;
- unauthenticated frontend requests are rejected by the existing approved-user
  guard; direct backend requests require the timing-safe frontend-server token;
- arbitrary query keys, UI pagination keys, and invalid enums are rejected;
- user/network-derived text beginning with `=`, `+`, `-`, or `@` (including
  leading whitespace) is prefixed as plain spreadsheet text;
- no database DSN, environment values, backend/service tokens, request dumps,
  SNMP credentials, communities, usernames, auth/priv passwords, or credential
  profile secrets are included.

The single spreadsheet dependency is `@excel.js/exceljs`. It is used only by the
backend and selected instead of the stale upstream package; the repository pins
it through `backend/package-lock.json`. A small backend adapter validates the
runtime export and uses the package's shipped declarations because its current
ESM metadata does not yet expose those declarations correctly to NodeNext. The
backend engine floor is Node.js 22.12, matching this dependency's supported
Node 22 range.

For local visual review without PostgreSQL or production records, run
`npm --prefix backend run preview:asset-report`. It writes a representative,
ignored workbook to `backend/test-output/P10E-asset-report-preview.xlsx` using
synthetic manual, active-scan, Managed SNMP, Health Watch, null-value, service,
change-history, logo, and formula-like fixtures.

## Operator-controlled runtime acceptance (not performed by source work)

1. Deploy through the reviewed release process; do not change database schema.
   Stop services first, create `/var/www/jhc/jhc_noc/shared/branding` with the
   service account as owner and restrictive permissions, set
   `REPORT_BRANDING_DIR` in `shared/backend/.env`, then start candidate services.
2. With no branding configured, export and confirm the generic no-logo header is clean.
3. As Admin configure `Rumah Sakit Jantung Jakarta`, division
   `IT Rumah Sakit Jantung Jakarta`, and an approved PNG/JPEG logo. Confirm a
   non-admin cannot modify branding and no filesystem path appears.
4. Open Asset Inventory as an approved user and export with no filters. Confirm
   the download, three sheets, and total matching assets against the UI.
5. Confirm logo, identity, localized title, and light section text render correctly.
6. Restart the candidate application and confirm branding persists. Replace,
   then remove the logo; each following export must reflect the change.
7. Apply a search, device type/status or other existing filter, and descending
   name sort. Move to a later UI page before exporting. Confirm all and only
   matching rows are present in the expected sort order, not just that page.
8. Confirm Summary criteria/counts and explicit limit indicators.
9. Review representative manual, active-scan, Health Watch, and Managed SNMP
   linked assets. Confirm no credential or token material is present.
10. Confirm Change History contains only those assets, readable Before/After
   values, and no operational status-only churn.
11. In an isolated disposable test fixture, use a formula-like label and confirm
   Excel displays it as text. Do not change real production identity for this.
12. Recheck Asset Inventory search/filter/sort/pagination/detail, NEW DEVICE,
   history, operational linkages, and P10D3 Scan Networks.

Rollback is source/config-only: stop candidate services, roll back `current`,
and remove `REPORT_BRANDING_DIR` if the older release does not recognize it.
Shared branding files may remain for a later retry. No schema or report data
requires cleanup.
