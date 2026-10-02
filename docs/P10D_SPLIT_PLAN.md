# P10D Asset Intelligence split plan

> **Historical design record:** references to the former evidence source describe the accepted P10D implementation phase. Current runtime evidence is read from local PostgreSQL through the backend.


Date: 2026-09-09. P10D1-A, P10D1-B, the narrowed P10D2 Asset Change History,
and P10D3 Scan Network Settings are implemented in source; runtime acceptance remains pending.

## Product boundary

Asset Inventory remains the compact entry point. Existing Discovery, Device
Inspector, Health Watch, Managed SNMP/Ruijie, Observed LAN Hosts, and Diagnostics
remain authoritative producers. P10D1-A consumes their already-normalized evidence.
P10D1-B adds one explicit active-scan capability inside the existing backend; it
does not add a second API/service, PM2 process, Flask/MariaDB service, port 5002,
arbitrary Nmap target/flags, or automatic network operation.

## P10D1-A Ã¢â‚¬â€ retained evidence ingestion (implemented in source)

### Persistence and reconciliation

Add a forward-only migration after P10C for bounded source observations and the
fields needed by the compact inventory: hostname, normalized open ports/services,
latency reference, OS/platform classification, vendor classification, device
type, confidence, evidence provenance, and source timestamps. Do not place raw
Nmap, SNMP, HTTP, packet, or credential payloads in PostgreSQL.

The local backend ingestion adapter reads existing data through their current
trusted server/backend boundaries:

| Source | Evidence accepted | Explicit non-authority |
|---|---|---|
| Observed LAN Hosts | Private IPv4, normalized MAC, NetBIOS enrichment, freshness, managed-target reference | Does not prove physical switch attachment or device identity. |
| Device Inspector | Fixed-port state, bounded service/HTTP/TLS/UPnP/NetBIOS fingerprint, confidence | Never auto-run from Asset Inventory and never overwrite operator identity. |
| Health Watch | Target link, latest ICMP status/latency | Offline does not prove powered off; no new probes. |
| Managed SNMP | Existing target/system/interface links and device evidence | No credential values, OID expansion, or Ruijie behavior change. |
| Discovery | Explicit bounded session evidence and saved node link | No continuous/full-LAN scan and no automatic inventory promotion without the defined action. |

Upserts must be idempotent on a defined stable source key, retain provenance, and
never merge records solely because names resemble each other. Vendor and OS/type
classification must remain evidence-based and allow `Unknown`. Locally
administered/randomized/private MAC addresses reduce confidence and are not
treated as stable manufacturer evidence.

### Asset Inventory UX

- Preserve four compact summary cards: Total, Online, Offline, Changed.
- Keep backend-sourced server time as a small indicator, not a metric card.
- Desktop table evolves to: No, Status, IP, Hostname, MAC, Vendor, OS, Type,
  Ports. Ports render a short count/summary; full ports/services stay in detail.
- Mobile remains cards without horizontal overflow.
- Search, type/status filters, Name A-Z/Z-A, paging, empty/loading/error states,
  and Clear Filters remain.
- Add one collapsed-by-default Insights section for OS/platform, vendor, and
  vendor-to-device-type summaries. Selecting an insight updates the main query;
  it does not render a duplicate asset table or dozens of permanent cards.
- The centered responsive detail dialog gains Overview and Network content.
  Relevant CTAs render only when the matching stable reference and authorization
  exist. No disabled placeholder action is shown.

P10D1 acceptance requires deterministic source-priority tests, idempotent upsert
tests, locally-administered/unknown MAC tests, evidence bounds, no automatic
network operation, compact responsive UI tests, and regression coverage for the
existing Ruijie/Observed Host/Inspector/Health paths.

The implementation performs a bounded, coalesced read-through synchronization
when Asset Inventory is requested (at most once per 30 seconds per backend
process). It reads only normalized Supabase latest/inventory evidence, consolidates
records by `node:<uuid>` or the conservative uncorrelated Observed Host key, and
uses one parameterized PostgreSQL bulk upsert. It never starts Discovery, Device
Inspector, SNMP, ICMP, Nmap, or another collector. A failed source refresh leaves
the retained local inventory readable.

## P10D1-B Ã¢â‚¬â€ active inventory enrichment (implemented in source)

An approved Operator/Admin can explicitly start Quick Discovery or Deep Inventory
Scan from `/assets`. The backend accepts only configured canonical RFC1918 CIDRs,
uses a fixed root-owned helper interface, parses bounded Nmap XML, and reconciles
by current MAC then IP into the existing stable-key asset row. Deep fingerprinting
uses bounded workers and per-host deadlines. One active job is allowed, cancel
terminates active processes, and restart recovery prevents stale `running` state.
No raw XML, credentials, P10D2 identity snapshots, or change events are stored.

## P10D2 Ã¢â‚¬â€ bounded Asset Changes history (implemented in source)

### Persistence

Migration 004 adds only `asset.change_events`. Application reconciliation writes
one permanent `created` event for a genuinely inserted row, or one grouped
`changed` event for meaningful allowlisted field differences. It deliberately
does not add identity/IP-history tables, infer identity collisions, or backfill
existing assets. Stable keys preserve the existing P10D1 identity semantics.
Normalized snapshots exclude timestamps, latency, confidence, internal links,
raw scanner output, and credentials. See `P10D2_ASSET_CHANGE_HISTORY.md`.

### History and detail UX

`Asset Changes` is a third `/history` tab with search, event-type and changed-field
filters plus bounded paging. The centered Asset detail dialog gains contextual
history on demand. A derived 24-hour PERANGKAT BARU / NEW DEVICE badge uses
backend `server_time`, `first_seen_at`, and qualifying network evidence sources;
it is not an asset status or stored boolean. Medical Equipment remains P10F.

## Requested legacy capability placement

| Capability | NetOps destination | Stage / presentation |
|---|---|---|
| Total/online/offline/changed | `/assets` | P10C compact cards. |
| Backend/server time | `/assets` header | P10C compact text sourced by local backend. |
| Device inventory fields | `/assets` main table | P10D1 compact columns; port count, not a long string. |
| OS/platform summary | `/assets` Insights | P10D1 collapsible, selection filters main table. |
| Vendor summary | `/assets` Insights | P10D1 collapsible; Unknown handled explicitly. |
| Vendor Ã¢â€ â€™ type summary | `/assets` Insights | P10D1 drill/filter, no duplicate table/card wall. |
| Device details | Centered dialog on `/assets` | P10C shell; P10D1 Overview/Network; P10D2 Identity/history. |
| Port/service details | Device detail Network view | P10D1 progressive disclosure. |
| MAC identity/IP history/change events | `/history` Ã¢â€ â€™ Asset Changes | P10D2 summary + compact event table. |
| Immutable scan results | Observation Snapshots | P10D2; normalized observations, not legacy scans/raw output. |
| Excel reporting | Contextual export from `/assets` and History | P10E; server-side and filter-aware. |
| Medical equipment registry | `/medical-equipment` under Asset Management | P10F, separate equipment domain, optional asset link. |
| Existing SNMP/Ruijie | `/snmp` and existing Device Profile | Unchanged; contextual links only. |

## Final cross-domain linkage

Asset Inventory is the inventory and identity/evidence hub, while the existing
operational domains remain separate and authoritative:

- Managed SNMP remains read-only telemetry. Asset Detail uses the retained
  `managed_telemetry_target_ref` only when that target still exists, to open the
  matching existing SNMP target;
  no credential value or telemetry table is copied into Asset Inventory.
- Health Watch remains continuous reachability monitoring. Asset Detail uses the
  retained `health_target_ref` only when that enabled target still exists, to
  open the matching existing monitoring target.
  Online/offline, ping, latency, and reachability transitions remain excluded
  from Asset Change History event-generating fields.
- Device Inspector remains bounded, on-demand fingerprint evidence. An
  Operator/Admin may explicitly launch the existing Inspector from Asset Detail
  only when the referenced inventory node still exists with a valid IPv4 and a
  capable runner. Opening Asset Detail itself never starts an inspection.

These links use retained stable UUID references produced by the existing
evidence adapter. No name/hostname reconciliation or permanent IP-only
relationship is introduced. The Inspector necessarily uses the current saved
IPv4 because that is the existing execution contract; the stable inventory-node
reference gates availability and the runner revalidates authorization.

### Operator-controlled runtime acceptance

After source review, perform this acceptance only on the Mini PC under operator
control:

1. Open an asset linked to Managed SNMP, confirm the linked state opens the
   correct target in `/snmp`, and confirm no credential material is displayed.
2. Open an asset without Managed SNMP and confirm the calm unlinked state.
3. Open a Health Watch-linked asset, confirm its monitored state opens the
   correct Dashboard target, then confirm an unmonitored asset stays unlinked.
4. Cause only an already-approved Health Watch status transition and confirm it
   does not add an Asset Change event whose `changed_fields` contains `status`.
5. From an authorized inventory-linked asset, explicitly open Inspector and
   confirm its target IP/context; merely opening Asset Detail must not create a
   Device Inspector session, and retained evidence must remain non-destructive.
6. Recheck Asset Inventory, Asset Detail, Before/After history, and the NEW
   DEVICE badge.
7. Recheck P10D3 Scan Networks, the SNMP workspace, and Health Watch without
   destructive SNMP or monitoring operations.

## New-user terminology (planned id/en copy)

| Term | English helper | Indonesian helper |
|---|---|---|
| MAC Identity | MAC is one identity signal used to track a device across IP changes; it is not guaranteed permanently unique. | MAC adalah salah satu sinyal identitas untuk melacak perangkat saat IP berubah; MAC tidak selalu unik secara permanen. |
| IP Changed | The same observed MAC was later seen using a different IP address. | MAC teramati yang sama kemudian terlihat menggunakan alamat IP berbeda. |
| MAC Changed | The same IP was observed with another MAC; DHCP reuse, replacement, virtualization, private/randomized MAC, or changing evidence may cause this. It is not automatically a security incident. | IP yang sama teramati dengan MAC berbeda; penyebabnya dapat berupa penggunaan ulang DHCP, penggantian perangkat, virtualisasi, MAC privat/acak, atau perubahan bukti. Ini tidak otomatis menjadi insiden keamanan. |
| New Device | A MAC identity not previously stored by Asset Inventory has been observed. | Identitas MAC yang belum pernah disimpan oleh Inventaris Aset telah teramati. |
| Observation Snapshot | A historical observation retained without rewriting older snapshots. | Catatan observasi historis yang disimpan tanpa menulis ulang snapshot lama. |
| OS Confidence | Confidence in OS classification based on available network evidence. | Tingkat keyakinan klasifikasi OS berdasarkan bukti jaringan yang tersedia. |
| Vendor | Estimated manufacturer from MAC and other evidence; some devices remain Unknown. | Perkiraan produsen berdasarkan MAC dan bukti lain; sebagian perangkat dapat tetap Tidak diketahui. |

## Simplification and risk decisions

- Do not expose D1 table columns until their normalized source fields exist;
  mapping the current generic `name` to Hostname would be misleading.
- Do not show Insights until evidence-backed aggregations exist.
- Do not place Asset Changes under `/assets`; History owns temporal evidence.
- Do not show inactive/meaningless CTAs or a permanent detail panel.
- Primary risks are identity collision, stale source state, inflated confidence,
  and an over-dense table. Source keys/provenance, conservative confidence,
  progressive disclosure, and separate staged migrations mitigate them.
