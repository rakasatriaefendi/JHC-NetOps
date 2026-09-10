# P10E Asset Reporting / Excel Export

P10E adds an on-demand, server-generated Excel report to the existing Asset
Inventory. It does not introduce another inventory model: the dedicated local
PostgreSQL `asset.assets` rows and P10D `asset.change_events` remain authoritative.

## Operator workflow and contract

From `/assets`, an approved user may apply the existing search, device type,
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
  counts, status/device-type counts, vendor/OS completeness, and explicit limit
  state.
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

## Operator-controlled runtime acceptance (not performed by source work)

1. Deploy through the reviewed release process; do not change database schema.
2. Open Asset Inventory as an approved user and export with no filters. Confirm
   the download, three sheets, and total matching assets against the UI.
3. Apply a search, device type/status or other existing filter, and descending
   name sort. Move to a later UI page before exporting. Confirm all and only
   matching rows are present in the expected sort order, not just that page.
4. Confirm Summary criteria/counts and explicit limit indicators.
5. Review representative manual, active-scan, Health Watch, and Managed SNMP
   linked assets. Confirm no credential or token material is present.
6. Confirm Change History contains only those assets, readable Before/After
   values, and no operational status-only churn.
7. In an isolated disposable test fixture, use a formula-like label and confirm
   Excel displays it as text. Do not change real production identity for this.
8. Recheck Asset Inventory search/filter/sort/pagination/detail, NEW DEVICE,
   history, operational linkages, and P10D3 Scan Networks.

Rollback is source-only: remove the export UI/Next route and stop registering
the Fastify report route. No report files or schema objects require cleanup.
