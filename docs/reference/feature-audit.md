# Legacy Network Inventory audit and P10C-P10F integration plan

Date: 2026-09-08. Branch: `feat/p10c-asset-inventory`.

The supplied reference is physically stored at
`docs/reference/network_inventory_legacy/` (underscore). All supplied Python,
shell, requirements, and README files were inspected. It is a feature reference,
not a deployable dependency.

## Architecture finding

The reference is a single Flask process with MariaDB/MySQL, an embedded UI,
periodic refresh, Nmap/ARP/reverse-DNS/ping collection, optional root execution,
systemd/inotify auto-reload scripts, and Excel generation. It binds a separate
port and has no NetOps Auth/RBAC boundary. It contains no SNMP collector. Those
runtime choices conflict with the current bounded runner/agent model and are not
being reproduced.

Current NetOps data flow remains:

```text
Browser -> Next.js approved-profile boundary -> Supabase Auth/data/Edge control plane
Runner -> loopback Fastify backend -> existing Supabase tables/RPCs (recurring plane)
Runner -> bounded agent/tools -> authorized targets
```

P10C adds only:

```text
Browser -> authenticated Next.js Server Component
        -> loopback Fastify /api/assets (server-only bearer)
        -> dedicated PostgreSQL 16/jhcnetops:5433 / jhc_netops / asset.*
```

There is no browser-to-PostgreSQL path, cross-database foreign key, second
scanner, or change to the current Supabase data plane.

## Feature matrix

| Legacy feature | Current NetOps equivalent / gap | Decision | Stage | Reason |
|---|---|---|---|---|
| LAN discovery | Bounded on-demand Discovery from actual Windows scope | KEEP CURRENT | P10D integration | Current scope/auth/concurrency rules are safer; do not duplicate scans. |
| Nmap host discovery | Current ICMP + neighbor-cache Discovery | DROP legacy runtime | P10D | Legacy privileged `nmap -sn` service is redundant. |
| Aggressive OS/service Nmap | Bounded Device Inspector with fixed ports/evidence | KEEP CURRENT | P10D integration | Drop `-O -sV --osscan-guess`; retain normalized safe evidence only. |
| ARP/MAC evidence | Discovery, Inspector, and SNMP Observed LAN Hosts | MERGE | P10D | Useful identity evidence, but only through existing authorized sources. |
| Reverse DNS/hostname | NetBIOS/operator identity/current fingerprints | MERGE | P10D | Preserve evidence provenance and avoid treating a guess as identity. |
| Port/service fingerprint | Device Inspector fixed allow-list | KEEP CURRENT | P10D | No arbitrary port or NSE input. |
| OS/platform inference with evidence/confidence | Partial current fingerprint classification | UPGRADE | P10D | Add conservative normalized confidence/evidence, never raw output. |
| Vendor classification | Existing MAC vendor/operator/SNMP evidence is fragmented | MERGE | P10D | Reconcile evidence without overwriting operator identity. |
| Device-type classification | Current device type plus detected identity | MERGE | P10D | Keep operator authority and record classification evidence. |
| Inventory/status/type/vendor summaries | No unified asset-domain summary | ADD | P10C/P10D | P10C adds compact total/status; richer categories follow evidence ingestion. |
| Search/filter/name sort/pagination | Present per-feature, not unified | ADD | P10C | Server-side bounded query with compact UI. |
| Progressive device detail | Reusable Device Profile, but no asset record view | MERGE | P10C/P10D | P10C detail exposes only local asset data and relevant contextual links. |
| MAC-centric durable identity | No unified local identity graph | ADD | P10D | MAC/IP identity and conflict semantics require a dedicated later migration. |
| Current/previous IP and IP history | Evidence exists in separate latest-state domains | ADD | P10D | Preserve immutable observation provenance; no inference in P10C. |
| NEW_DEVICE/IP_CHANGED/MAC_CHANGED | Existing events do not model unified asset identity | ADD | P10D | Define deduplicated transitions after source reconciliation. |
| Immutable scan results/history | Discovery is intentionally ephemeral; diagnostics have separate history | MERGE | P10D | Add bounded asset observations, not raw or duplicate scan payloads. |
| Excel workbook summaries/export | No Asset Inventory workbook | ADD | P10E | Required server-generated export respecting active filters. |
| Medical-device label rules | Current general device type only | UPGRADE | P10F | Separate equipment registry without patient/clinical data. |
| Flask/MariaDB/port 5002 | Fastify/Next.js/local PostgreSQL target architecture | DROP | - | Avoid second service, DB engine, port, and auth boundary. |
| Root/inotify auto-reload | Reviewed NetOps launchers/process manager | DROP | - | Unsafe and unnecessary production coupling. |
| Raw JSON storage | Normalized bounded JSONB evidence | DROP/UPGRADE | P10D | Never store raw scan output, HTML, packet data, or credentials. |
| SNMP | Reference contains no SNMP | KEEP CURRENT | All stages | Current read-only Managed SNMP/Ruijie behavior remains authoritative. |

## Local PostgreSQL model

P10C migration `001_asset_inventory_foundation.sql` creates only
`asset.assets`. It uses UUID identity, `inet`, `macaddr`, `timestamptz`, bounded
enums/checks, normalized bounded JSONB evidence, and indexes for name/type/status,
last-seen, IP, and network-node reference. Supabase identifiers are nullable UUID
references with no cross-database constraints.

Planned additions, deliberately not implemented now:

- P10D: `asset.identities`, `asset.ip_history`, `asset.observations`, and
  deduplicated identity-change events; application reconciliation from existing
  Discovery, Inspector, Health, Observed Host, and Managed SNMP sources.
- P10E: server-side XLSX generation from the same allowlisted asset query contract,
  with summary, filtered inventory, platform/type/vendor, identity/IP/change, and
  observation sheets.
- P10F: isolated `biomedical.*` equipment, calibration, maintenance, and service
  tables; nullable asset link and no patient/clinical fields.
- P11: move existing domains into the same dedicated database later, schema by
  schema. P10C requires no redesign for that migration.

## API, auth, and UX boundaries

- `GET /api/assets` accepts only bounded `q`, `device_type`, `status`, `sort`,
  `page`, and `page_size`; fixed SQL sort expressions and parameterized filters.
- `GET /api/assets/:id` accepts only a UUID.
- The backend uses a separate timing-safe frontend-server token, a five-connection
  pool, five-second statement timeout, and sanitized errors.
- Next.js performs the existing approved-profile check before any asset request;
  the server-only token is never `NEXT_PUBLIC_*`.
- UI reuses current panel/control/table/card patterns: four summary cards, compact
  filters, Name A-Z/Z-A, 10-row default paging, desktop table/mobile cards, and an
  inline progressive detail panel. Only references that exist render CTAs.
- Empty, unconfigured, and temporary-error states are explicit in Indonesian and
  English. Incomplete P10D2/P10E/P10F actions are not shown.

## Dedicated cluster and deployment constraint

The only permitted target is PostgreSQL `16/jhcnetops`, port `5433`, database
`jhc_netops`, owner `jhc_netops_owner`, application role `jhc_netops_app`, and
loopback-only listen/HBA rules. Existing `16/main`, port 5432, its roles/config,
and `mercure`/`montblanc` are out of scope. The backend validates this DSN shape at
startup. Reviewed, non-secret future steps are in `deploy/postgresql/README.md`;
nothing was provisioned in this task.

## Staged acceptance criteria and risks

P10C is accepted when the migration is non-destructive, configuration refuses the
shared cluster, API auth/query/error bounds pass, approved users can see compact
localized inventory/empty/error states through Next.js, and existing backend and
frontend gates remain green.

P10D1 uses explicit source priority and conservative source keys for current
network evidence; MAC identity collision/history remains deferred to P10D2.
P10E must add an XLSX dependency only after security/memory
bounds are reviewed. P10F must remain equipment-only. Operational risks are a
misconfigured DSN, stale local inventory, and cross-source identity ambiguity;
startup validation, no cross-DB FK, explicit source/evidence fields, and staged
ingestion mitigate them.

The post-review implementation split, terminology, and exact compact UI placement
are recorded in `docs/P10D_SPLIT_PLAN.md`. P10D1 is implemented in source;
P10D2 remains intentionally unimplemented.
