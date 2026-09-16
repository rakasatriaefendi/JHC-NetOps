# P13 Application DB Cutover

## Status and phase boundary

This document is the source-only design for P13.1-P13.3. It does not authorize
a database connection, migration, final copy, deployment, or authority switch.

P13 moves application persistence for the 21 P12-audited `public` tables to the
dedicated local PostgreSQL `16/jhcnetops` cluster on port `5433`. The existing
`asset.*` domain remains locally authoritative and must not be rebuilt or
overwritten by the application-table migration.

The phase boundaries remain explicit:

- Supabase Auth remains the identity/session authority until P15.
- Supabase Realtime remains the UI event transport until P14.
- Supabase is not decommissioned in P13; that is P16.
- A Supabase row retained for Auth or Realtime compatibility is a shadow
  projection, not an application persistence authority.

The accepted P12 Run `20260914b` proves schema/data compatibility for the 21
tables, but its independent REST reads are non-atomic and cannot be reused as a
final cutover checkpoint while writers are active.

## Source audit scope

The audit traced the current paths in:

- `frontend/app`, `frontend/components`, and `frontend/lib`;
- the local Fastify backend repositories and route registration;
- all deployed Edge Function source under `supabase/functions`;
- Supabase migrations, RLS policies, RPCs, Realtime publication changes, and
  scheduled cleanup functions;
- runner transport and its durable Health/SNMP state;
- agent metric, diagnostic, and Traffic delivery plus SQLite buffers;
- P11/P12 migration, import, verification, and reconciliation code.

No source evidence of a general Supabase-to-local CDC stream or trustworthy
delete tombstone was found. The 21-table production schema is now prepared as
`backend/migrations/007_application_persistence.sql`, but only profiles, runner heartbeat,
inventory/target config, Health Watch, Traffic, and Managed Telemetry have initial local repositories. `backend/src/main.ts` still constructs Supabase
repositories for the four recurring domains in Supabase mode and refuses to arm
local mode until complete parity and projection gates exist.

## Current and desired authority matrix

Legend:

- **Local**: local PostgreSQL is already authoritative.
- **SDB**: Supabase Database is authoritative today.
- **SRT**: Supabase Realtime currently carries row-change UI updates.
- **SA**: Supabase Auth/user UUID is coupled to the row.
- **Buffer**: temporary durable local state must be checkpointed.

| Domain | Table/state | Current readers | Current writers | Current authority/coupling | P13 desired authority | Required P13 change | Main risk |
|---|---|---|---|---|---|---|---|
| User access | `profiles` | frontend auth resolver/admin; every approved-user/RLS helper | Supabase Auth `handle_new_user` trigger; `admin_update_profile_access` RPC | SDB + SA; shadow row is also used by RLS | Local row for profile/role/status; SA remains; SDB shadow only for Auth/Realtime/RLS compatibility | local profile repository/API; frontend profile reads/admin mutations local; bounded Auth-to-local bootstrap for new pending users; local-to-shadow projection | stale shadow can over/under-authorize Realtime; signup during checkpoint |
| Runner registry | `diagnostic_runners` | frontend diagnostics/devices/assets/SNMP; all job functions; backend target joins | local backend heartbeat repository; diagnostic preflight actions | SDB + SRT | Local; SDB shadow | PostgreSQL heartbeat/preflight repository and Realtime projection | heartbeat/preflight concurrent updates and stale-runner semantics |
| Inventory | `network_nodes` | frontend pages/profile; Edge authorization; backend asset evidence | frontend server actions and client providers; saved identity paths | SDB; `created_by` SA | Local | local CRUD/read API; remove direct Supabase mutation; local asset evidence source | identity conflicts and cascading target deletes |
| Health config | `network_targets` | frontend/dashboard; Health/Inspector/Traffic authorization; backend Health | frontend actions, Discovery add, Device Profile add | SDB; `created_by` SA; UI subscribes though migration does not explicitly publish it | Local; optional SDB shadow for current UI event compatibility | local target CRUD and reads; PostgreSQL Health target repository; remove direct Supabase writes | enabled target changes race runner cache; cascades/latest cleanup |
| SNMP config | `managed_telemetry_targets` | frontend SNMP/assets/profile; backend SNMP | frontend SNMP actions | SDB; `created_by` SA | Local | local CRUD/read repository; secure credential-reference handling unchanged | sensitive legacy column and enabled polling state |
| LAN diagnostics jobs | `diagnostic_jobs` | diagnostics UI/history; Edge busy checks; runner | diagnostic-jobs Edge creates/claims/updates/completes/fails | SDB + SRT + SA (`requested_by`) | Local; SDB shadow for SRT | local user and runner control-plane routes; PostgreSQL repository; Edge write guard | queued/running work and one-active-runner invariant |
| Traffic control | `traffic_live_sessions` | Traffic UI/Edge/backend; all busy checks | Traffic Edge creates/stops; local backend claims/stages/finishes; recovery RPC | SDB + SA (`requested_by`); UI subscribes | Local; SDB shadow where needed for UI transport | local user control route plus PostgreSQL runner repository and stale-session recovery | queued/running/stopping capture, expiry, duplicate claim |
| Discovery control | `network_discovery_sessions` | frontend/Inspector authorization/busy checks; runner | Discovery Edge prepares/claims/progresses/completes/fails/expires | SDB + SRT + SA | Local; SDB shadow for SRT | local control and runner routes; Edge write guard | one row per runner, expiry, result payload |
| Inspector control | `device_inspection_sessions` | frontend/busy checks; runner | Device Inspector Edge starts/claims/stages/completes/fails/expires | SDB + SRT + SA | Local; SDB shadow for SRT | local control and runner routes; Edge write guard | one row per runner, active result lifecycle |
| Health latest | `network_health_latest` | dashboard, devices, asset evidence | local backend Health publish | SDB + SRT | Local; SDB shadow for SRT | PostgreSQL publish transaction and outbox projection | latest-state ordering and stale projection |
| Health history | `network_health_samples` | frontend downsample RPC | local backend Health publish; Supabase retention cron deletes | SDB | Local | PostgreSQL upsert/downsample/retention implementation; stop Supabase cleanup writer | minute-key idempotency and retention deletes |
| Manual Ping | `network_health_ping_jobs` | frontend provider; runner | Network Health Edge creates/claims/completes/fails and deletes expired | SDB + SRT + SA | Local; SDB shadow for SRT | local authenticated enqueue and runner routes; Edge write guard | active request during freeze and short expiry |
| SNMP device latest | `managed_device_latest` | SNMP/profile/asset evidence | local backend Managed Telemetry publish | SDB + SRT | Local; SDB shadow for SRT | PostgreSQL target-scoped publish and outbox | ordering of poll results |
| SNMP interface latest | `managed_interface_latest` | SNMP/profile | local backend publish upserts and removes absent interfaces | SDB + SRT | Local; SDB shadow for SRT | one local transaction for upsert plus stale-interface removal | partial replacement must not expose mixed generations |
| Observed LAN Hosts | `managed_observed_hosts_latest` | SNMP/profile/asset evidence | local backend marks absent rows stale and upserts current rows | SDB + SRT | Local; SDB shadow for SRT | preserve first-seen/node-correlation/current-stale transaction | high row count and stale/current atomicity |
| Traffic latest | `traffic_live_snapshots` | Traffic/dashboard/Discovery UI | local backend/agent Traffic publish | SDB + SRT | Local; SDB shadow for SRT | PostgreSQL upsert and outbox | session FK and rapidly changing snapshot |
| Traffic flows | `flows` | Supabase approved reads; Traffic storage accounting | local backend/agent batches; retention cron deletes | SDB; agent SQLite Buffer | Local | PostgreSQL flow upsert/storage status/retention | buffered retries, storage bounds, retention deletes |
| Bandwidth history | `bandwidth_measurements` | diagnostics/history Edge consumed by frontend | agent diagnostics delivery through `diagnostics` Edge | SDB | Local | local agent ingest route and local read/history API | POST retry has no explicit idempotency key beyond contextual fields |
| Hop history | `hop_measurements` | diagnostics/history Edge consumed by frontend | agent diagnostics delivery through `diagnostics` Edge | SDB | Local | local agent ingest route and local read/history API | batch replay can duplicate because no schema uniqueness exists |
| Aggregate monitor | `traffic_metrics` | approved frontend/RLS paths; Realtime publication | periodic agent through `ingest` Edge | SDB + SRT; agent SQLite Buffer | Local; SDB shadow only if the existing SRT consumer is retained | local bounded ingest route and projection | buffered replay and generated UUID duplication behavior |
| Shared event history | `events` | dashboard/alerts/history/SNMP/profile | local backend Health and Managed Telemetry publishers | SDB + SRT | Local; SDB shadow for SRT | PostgreSQL event dedupe/resolution in the same domain transaction plus outbox | mixed sources, open-event resolution, event-ID dedupe |
| Asset inventory | `asset.assets`, `asset.change_events`, `asset.scan_runs`, `asset.scan_networks`, medical tables | local backend/frontend proxy | local backend repositories/scanner | Local | Local, unchanged | only replace `SupabaseAssetEvidenceSource` with local evidence reads after identity gate | accidental evidence sync can overwrite local authority |
| Branding | filesystem under `REPORT_BRANDING_DIR` | local backend | local backend | Local file state | unchanged | none | include in operational checkpoint, not P13 table copy |
| Runner Health cache | `network-health-state.json` | runner | runner | Buffer | unchanged Buffer; drain/checkpoint around switch | preserve cached targets/states/pending transition IDs | replay to wrong authority |
| Runner SNMP cache | `snmp-telemetry-state.json` | runner | runner | Buffer | unchanged Buffer; drain/checkpoint around switch | preserve cached targets/counters/pending event IDs | rate baseline or event replay loss |
| Agent metrics buffer | `metrics-buffer.sqlite3` | agent | agent | Buffer | unchanged Buffer; delivery becomes local | flush/checkpoint and bind replay endpoint to selected authority | old payload replay to SDB after switch |
| Agent Traffic buffer | `traffic-buffer.sqlite3` | agent | agent | Buffer | unchanged Buffer; delivery remains local backend | drain active session or retain for local replay only | active capture and duplicate flow replay |

### Direct frontend Supabase persistence to remove

The current frontend is not merely a reader. P13 must reroute all of these:

- `frontend/app/actions/devices.ts`: `network_nodes` and `network_targets`
  insert/update/delete/upsert.
- `frontend/components/diagnostics/network-nodes-provider.tsx`: direct
  `network_nodes` insert/update/delete.
- `frontend/components/dashboard/network-discovery-drawer.tsx` and
  `frontend/components/device-profile/device-profile-provider.tsx`: direct
  `network_targets` upsert.
- `frontend/app/actions/snmp.ts`: `managed_telemetry_targets`
  upsert/update/delete.
- `frontend/app/actions/admin.ts`: `admin_update_profile_access` RPC.
- authenticated Edge invocations that create/stop/prepare work: diagnostics,
  Traffic, Discovery, Device Inspector, and Manual Ping.

All ordinary application reads must also move to server-side local APIs. The
browser may retain the Supabase client only for Auth/session and Realtime
subscriptions during P13.

## Complete Supabase writer inventory to disable or reroute

### Local backend and runner

- `SupabaseRunnerHeartbeatRepository`: upserts `diagnostic_runners` and invokes
  `expire_stale_traffic_sessions`.
- `SupabaseNetworkHealthRepository`: reads targets; upserts latest/samples;
  resolves/inserts `events`.
- `SupabaseTrafficRepository`: expires/claims/updates sessions, upserts snapshots
  and flows, and calls `traffic_storage_status`.
- `SupabaseManagedTelemetryRepository`: reads targets; replaces device/interface
  latest state; marks/upserts observed hosts; resolves/inserts events.
- Runner low-frequency actions still call Edge Functions for diagnostic jobs,
  Manual Ping, Discovery, and Device Inspector even when recurring paths use the
  local backend.

### Agent

- `IngestClient` periodically writes `traffic_metrics` through `ingest` and can
  replay `metrics-buffer.sqlite3`.
- `DiagnosticsClient` writes bandwidth and hop rows through `diagnostics`.
- Traffic flow/snapshot delivery already reaches the local backend when local
  configuration is complete, but that backend still writes Supabase today.

### Edge Functions

- `diagnostic-jobs`: runner heartbeat fallback, preflight state, diagnostic job
  creation/claim/progress/context/completion/failure, and traffic recovery RPC.
- `diagnostics`: bandwidth/hop insert and diagnostic history reads.
- `traffic-live`: session creation/stop/claim/stage/finish, snapshot/flow writes,
  recovery and storage RPCs.
- `network-health`: Manual Ping create/claim/finish/expiry plus legacy recurring
  Health target/latest/sample/event paths.
- `network-discovery`: prepare/claim/progress/complete/fail/expiry.
- `device-inspector`: start/claim/stage/complete/fail/expiry.
- `managed-telemetry`: legacy target list and device/interface/host/event publish.
- `ingest`: periodic `traffic_metrics` insert.

### Supabase-side writers

- `handle_new_user` inserts a pending `profiles` row from Supabase Auth.
- `admin_update_profile_access` mutates role/status/approval metadata.
- `expire_stale_traffic_sessions` mutates active Traffic sessions.
- scheduled `traffic-retention-cleanup` deletes sessions/snapshots/flows.
- scheduled `network-health-samples-cleanup` deletes Health history.
- table `updated_at` triggers mutate timestamps as part of caller writes.
- authenticated RLS policies currently permit operator mutations of
  `network_nodes`, `network_targets`, and `managed_telemetry_targets`.

The P13 Supabase cutover guard must revoke/deny application mutations and stop
the two Supabase retention jobs before the final checkpoint. Retained Edge code
must fail closed for mutating actions once local authority is active. Merely
changing the current frontend is insufficient because old clients and direct
authenticated API calls would remain valid writers.

Fixture/E2E scripts with service-role access are not runtime writers, but they
must be marked incompatible with the shadow store or updated before anyone runs
them after cutover.

## Realtime boundary through P13

Current browser subscriptions consume row changes for:

- `diagnostic_runners` and `diagnostic_jobs`;
- `traffic_live_snapshots` (and an attempted session subscription);
- `network_health_latest`, `network_targets`, and Health `events`;
- `network_health_ping_jobs`;
- `network_discovery_sessions`;
- `device_inspection_sessions`;
- `managed_device_latest`, `managed_interface_latest`, and
  `managed_observed_hosts_latest`;
- `traffic_metrics` where the legacy aggregate view is used.

Supabase Realtime cannot observe local PostgreSQL commits. Switching only the
repository would silently break these UIs. This is a P13 blocker, not permission
to implement P14.

The P13-compatible boundary is:

1. Commit the authoritative domain mutation and an outbox item in one local
   PostgreSQL transaction.
2. A bounded backend projector applies the normalized row/upsert/delete to the
   corresponding Supabase shadow table with an idempotency key/version.
3. Existing Supabase Realtime emits from that shadow row.
4. Frontend initial reads and mutation results come from local APIs. A Realtime
   event either carries the exact projected normalized row or triggers a local
   refetch; it never makes Supabase authoritative again.
5. Projector lag/failure is visible and retryable. It must not roll back the
   already-committed local mutation and must not cause a write back from
   Supabase to local.

An in-process best-effort dual write is rejected: a crash between stores creates
untracked split-brain. The outbox and its retry state belong to local
PostgreSQL. Projection payloads must exclude secrets; in particular no local
credential value or service-role credential is browser-visible.

Supabase shadow tables must retain parent rows required by their foreign keys
and `profiles` rows required by Realtime RLS. That makes the shadow a controlled
compatibility projection, not a second write authority.

## Auth boundary through P13

Supabase continues to issue sessions and user UUIDs. P13 must not copy
`auth.users`, passwords, tokens, or sessions.

Application authorization (`profiles.status` and `profiles.role`) moves local:

- Next.js continues to validate the Supabase session/claims.
- protected application reads and mutations load the local profile and fail
  closed unless it is approved and has the required role.
- the loopback backend must not trust a browser-supplied role. It accepts only a
  server-side authenticated call and resolves the actor UUID against local
  `profiles` for authorization-sensitive mutations.
- the existing Auth trigger may create a provisional pending shadow profile for
  a newly registered Supabase user. A bounded server-side bootstrap imports the
  Auth UUID/email/name into local PostgreSQL as pending if absent; after that,
  local role/status/approval metadata is authoritative and projected back to the
  Supabase profile shadow for RLS/Realtime.
- registration is frozen during the final source checkpoint so a new Auth user
  cannot appear between profile capture and authority switch.

`requested_by`, `created_by`, and `approved_by` remain logical references to
Supabase user UUIDs through P15. They must not gain foreign keys to an un-migrated
local Auth catalog.

## Identity conflict disposition

### What P12 actually classifies

P12 constructs identities from `network_nodes` and unlinked
`managed_observed_hosts_latest` rows. It tries, in order of evidence availability:

- existing `network_node_ref`;
- equal `stable_source_key`;
- the same observed target plus IP;
- existing Health/Managed target reference;
- otherwise matching MAC evidence.

It emits `AMBIGUOUS` when one source maps to multiple local assets or multiple
sources map to the same single local asset. A unique candidate becomes
`CONFLICT` when IP, MAC, target references, selected name/type, or IP/MAC
ownership differs. No candidate is `SOURCE_ONLY`; unmatched local data is
`LOCAL_ONLY`.

### Conservative P13 policy

| Category | P13 disposition |
|---|---|
| `EXACT_MATCH` | Preserve the existing local asset ID and operator-owned fields. Automatic reference preservation is allowed only for UUID/reference-backed rules whose stored values already agree. An apparent exact match based only on `unique_mac_evidence` remains an operator-review item; MAC helps identity but does not alone authorize a merge. |
| `SOURCE_ONLY` | Copy the source row into the new local `public` application schema, but do **not** automatically create an `asset.assets` row. Queue it for later explicit inventory disposition or let an approved post-cutover evidence policy create it. `SOURCE_ONLY` is not synonymous with insert. |
| `LOCAL_ONLY` | Preserve the local asset unchanged. Never delete it because Supabase lacks a matching identity. |
| `CONFLICT` | Never overwrite either side. Record the source/local IDs, rule, and differing fields; require an operator decision such as keep-separate, relink-reference, or explicitly merge into the chosen local asset. |
| `AMBIGUOUS` | No automatic winner and no fan-in/fan-out merge. Operator must identify the durable mapping or explicitly keep the records separate. |

IP alone is never a durable merge key. DHCP reassignment, locally administered
MAC addresses, duplicate/virtual MACs, and the same observed IP under different
managed targets all require context. The stable `network_nodes.id` /
`network_node_ref` relationship has the highest confidence when internally
consistent.

`CONFLICT`, `AMBIGUOUS`, and any MAC-only proposed exact match are hard blockers
to enabling the post-cutover Asset evidence synchronizer. They are also a P13
acceptance gate unless the operator records an explicit keep-separate
disposition. `SOURCE_ONLY` and `LOCAL_ONLY` are not blockers when the
non-destructive defaults above are approved.

The current `BoundedAssetSynchronizer` runs from Asset API paths and can insert
or update by `stable_source_key`. It must remain disabled across the cutover
until the restricted P12 identity report has been reviewed and the disposition
artifact has been accepted. P13 must not silently convert a reconciliation
report into writes to `asset.*`.

## Final copy and deterministic delta design

### Required artifact model

Use the accepted P12 canonical table definitions, keys, bounded pagination,
hashing, and lossless JSON as the base. P12's importer is insert-only into an
empty rehearsal database; it is not a P13 delta applier.

P13 needs two source artifacts:

- **S0**: a pre-cutover full baseline captured while the application remains
  live and imported into local `public` tables without changing authority.
- **S1**: a final full keyset/content checkpoint captured after every source
  writer and cleanup job is demonstrably quiescent.

The S1 capture remains physically table-by-table REST, but becomes logically
stable only because the source is write-free for the entire capture window.
Row counts must remain unchanged during every page and a writer audit/checkpoint
must bracket the complete window. If write-free evidence cannot be obtained,
REST is insufficient and the cutover is blocked pending an atomic source export.

Derive a canonical delta from S0 to S1:

- inserted key + row;
- changed key + complete replacement row;
- deleted key tombstone;
- unchanged key count/hash.

Apply that delta to local PostgreSQL in one guarded transaction, then compare
canonical counts/keysets/hashes against S1 before switching authority. This
avoids trusting `updated_at` and reproduces deletes without needing historical
tombstones. It never touches `asset.*`.

### Per-table strategy

| Table | Final strategy | Stable key / watermark | Delete handling | Conflict and verification |
|---|---|---|---|---|
| `profiles` | canonical PK delta after registration/admin freeze | `id`; no timestamp watermark | explicit S1-minus-S0/local key tombstones | preserve all Auth UUID refs; full row hash and approval invariant |
| `diagnostic_runners` | final latest-row replacement delta | `id`; `updated_at` is evidence only | explicit absent-key delete after dependent rows | heartbeat/preflight must be quiescent; row hash |
| `network_nodes` | canonical PK delta | `id`; never IP-only | explicit delete only from S1 keyset, children first | identity disposition gate; IP uniqueness and full hash |
| `network_targets` | canonical PK delta | `id` | explicit tombstones before parent deletes | verify `(runner_id,node_id)` uniqueness and active set |
| `managed_telemetry_targets` | canonical PK delta | `id` | explicit tombstones before parent deletes | exact sensitive-column hash; never log value; active set |
| `diagnostic_jobs` | full mutable-row PK delta after drain | `id` | explicit tombstones | no queued/running rows; one-active index; row hash |
| `traffic_live_sessions` | full mutable-row PK delta after capture drain | `id` | explicit tombstones; preserve retention result | no queued/running/stopping rows; row hash |
| `network_discovery_sessions` | final-only row replacement | `runner_id` (`session_id` remains unique) | explicit absent-runner delete | no queued/running rows; full result hash |
| `device_inspection_sessions` | final-only row replacement | `runner_id` (`inspection_id` remains unique) | explicit absent-runner delete | no queued/running rows; result hash |
| `network_health_latest` | final-only keyed replacement | `target_id` | explicit absent-target delete | compare against target set and row hash |
| `network_health_samples` | canonical append/history delta | `id`; logical unique `(target_id,sampled_at)`; timestamps not sole watermark | exact key tombstones capture retention deletes | count/keyset/hash; sequence reset to max ID after apply |
| `network_health_ping_jobs` | full mutable-row PK delta after drain/expiry | `id` | explicit tombstones | no queued/running rows; target/runner refs |
| `managed_device_latest` | final-only keyed replacement | `target_id` | explicit absent-target delete | target coverage and row hash |
| `managed_interface_latest` | target-scoped complete replacement delta | `(target_id,if_index)` | delete keys absent from S1 | no mixed poll generation; count/hash per target |
| `managed_observed_hosts_latest` | target-scoped complete replacement delta | `(target_id,ip_address)` | delete absent keys; retained rows keep source `first_seen_at` | current/stale counts and hash per target; node correlation |
| `traffic_live_snapshots` | final-only keyed replacement | `runner_id`; `session_id` unique | explicit absent-runner delete | session FK and payload hash |
| `flows` | canonical history delta after Traffic drain/cleanup freeze | `id`; logical `(session_id,flow_key)`; no timestamp-only delta | exact key tombstones capture retention deletes | count/keyset/hash and session FK |
| `bandwidth_measurements` | canonical append/history delta | `id`; `measured_at` is not sufficient alone | exact tombstones if any | count/keyset/hash and job refs |
| `hop_measurements` | canonical append/history delta | `id`; no reliable update watermark | exact tombstones if any | count/keyset/hash, job/session grouping |
| `traffic_metrics` | canonical append/history delta after agent buffer drain | `id`; `recorded_at` is not sufficient alone | exact tombstones if any | count/keyset/hash; buffer count zero or sealed for local replay |
| `events` | canonical mutable-history delta | `id`; `resolved_at` can change old rows | exact tombstones | count/keyset/hash; open/resolved event invariants |

No table uses a timestamp-only final delta. Several tables lack `updated_at`,
old rows can be resolved later, and source retention performs deletes. The final
complete S1 keyset is the authoritative delete manifest.

## Write-freeze and checkpoint flow

Stopping all PM2 processes is neither necessary nor sufficient. The freeze is
writer-specific:

1. Deploy and verify dormant P13 code with Supabase still authoritative. Create
   the local application schema and import S0 without enabling local writers.
2. Review the restricted reconciliation report. Record every conflict,
   ambiguity, and MAC-only case as map/keep-separate; keep Asset evidence sync
   disabled.
3. Enter application maintenance mode for persistence mutations. Existing
   read-only pages may remain available, but block registration, admin access
   changes, inventory/target edits, and new Diagnostics/Traffic/Discovery/
   Inspector/Manual Ping requests.
4. Stop the two Supabase cleanup schedules and record their last execution.
   Deploy/enable the Edge and RLS cutover guard so new source mutations fail
   closed. The Auth profile trigger must also be covered by the registration
   freeze.
5. Stop new runner claims/polls, then let already-running operations reach a
   bounded terminal state. Verify there are no queued/running/stopping rows.
6. Flush the agent metric buffer to Supabase while it is still the authority,
   stop its periodic writer, and record the SQLite count/hash. Drain Traffic or
   retain a sealed buffer that is explicitly rebound for local replay. Publish
   pending Health/SNMP transitions, stop their loops, and record cache
   counts/hashes/event IDs.
7. Confirm that frontend, backend, runner, agent, Edge, RLS, Auth-trigger, and
   scheduled writers are all quiescent. Record source table counts/key hashes.
8. Capture immutable S1 for all 21 tables. Recheck writer evidence and counts at
   the end of the complete capture window.
9. Produce the signed/canonical S0-to-S1 delta and delete manifest. Checkpoint
   local `jhc_netops` (including `asset.*`) before apply.
10. Apply the P13 delta once, transactionally, to local `public`; adjust the
    Health sample sequence; run P12 parity plus P13 active-state and identity
    verification against S1.
11. Switch application configuration once to local authority. Start backend
    first, then frontend, runner, and agent. They must have no fallback to an
    old Edge persistence path. Enable the local outbox projector only after the
    local authority switch.
12. Smoke-test Auth, role gates, reads, one bounded write per subsystem, runner
    heartbeat, queued-work lifecycles, buffer replay, and Realtime projection.
    Keep Asset evidence sync disabled until its identity gate is cleared.

Only NetOps processes/writers are in scope. Unrelated PM2 applications and
PostgreSQL `16/main` are never stopped or changed.

## Roll-forward and rollback boundary

Required retained checkpoints are the immutable S1 source artifact, S0-to-S1
delta/delete manifest, pre-apply local dump, post-apply verification report,
identity dispositions, runner/agent cache manifests, and outbox watermark.

Before the first accepted local mutation, rollback can restore prior application
configuration and the pre-apply local checkpoint while Supabase S1 remains
authoritative. After local writes begin, rollback to Supabase is safe only if
every authoritative local mutation and delete has been projected, source/shadow
parity is reverified, and all local writers are frozen for the reverse switch.
Otherwise rollback would lose or fork data. At that point the default response
is roll-forward repair, not an unverified authority reversal.

At no point may normal writers target both stores independently. Only the local
transactional outbox may update Supabase shadows after the switch.

## Expected Batch 2 source changes

Exact filenames may be narrowed during implementation, but the audited change
surface is expected to include:

1. The production application schema is prepared in
   `backend/migrations/007_application_persistence.sql`, derived from the P12
   rehearsal schema. Its projection outbox/cutover metadata is deferred to the
   next separately reviewed batch. Normal migrations `001`-`006` remain intact.
2. Reusable migration tooling under `backend/src/data-migration/` for canonical
   S0/S1 diff, delete manifests, guarded transactional apply, and verification;
   existing P12 behavior and artifacts remain compatible.
3. PostgreSQL repository implementations in the existing
   `runner-heartbeat`, `network-health`, `traffic`, and `managed-telemetry`
   modules, plus local repositories/routes for profiles, inventory/targets,
   diagnostics, Discovery, Inspector, Manual Ping, events/history, and metrics.
4. `backend/src/main.ts`, `backend/src/config.ts`, and `backend/src/server.ts` for
   an explicit authority mode, one dedicated pool, route wiring, outbox worker,
   and fail-closed startup validation. There must be no per-operation fallback.
5. `runner/src/backend.mjs` and focused runner tests so all job, preflight,
   Manual Ping, Discovery, and Inspector actions use local routes after cutover;
   recurring paths remain local.
6. Agent config/delivery modules and tests so `ingest` and `diagnostics` use the
   loopback backend after cutover, preserving both SQLite buffers and retry
   semantics.
7. Frontend server-side data adapters/actions for every current direct Supabase
   read/write. The Supabase browser/server clients remain only for Auth and
   Realtime. The affected pages/components are those identified in the matrix,
   not a visual redesign.
8. A Supabase migration and bounded Edge guard changes that revoke old direct
   application writes, stop Supabase cleanup schedules, and reject legacy
   mutating Edge actions while retaining Auth/Realtime shadow reads.
9. Deployment examples/runbook updates for authority mode, freeze evidence,
   immutable checkpoints, rollback boundary, and secret-safe environment names.
10. Contract/parity tests spanning local repositories, old Edge semantics,
    frontend adapters, runner/agent transports, outbox idempotency, and failure
    injection.

This is necessarily broader than replacing four backend repository classes:
otherwise control-plane Edge Functions, direct RLS writes, agent ingestion, and
frontend reads would leave Supabase authoritative or create split-brain.

## Runtime evidence gates

The following cannot be closed source-only and require an on-site pre-cutover
operator run:

- restricted P12 identity findings and an explicit disposition for each hard
  case;
- current counts/sizes and the bounded duration of S0/S1 capture/import;
- active queued/running/stopping jobs and sessions;
- runner Health/SNMP cache contents and pending event IDs;
- agent SQLite buffer counts/hashes and any live Traffic capture;
- actual Supabase cron job state/last execution and confirmation that all old
  Edge/RLS writers fail closed;
- local disk headroom, dump/checkpoint duration, outbox lag, and Supabase shadow
  parity;
- a full source-vs-local verification immediately before switch;
- post-switch smoke tests and the point at which rollback ceases to be safe.

## Source-only readiness verdict

Batch 2 can proceed source-only **only** as dormant, tested implementation
behind an explicit authority switch that defaults to the current Supabase mode.
It can build the production schema, repositories, adapters, outbox, guards,
delta tooling, and tests without accessing either database.

P13 cannot be accepted or switched source-only. Runtime identity disposition,
writer quiescence, S1 capture, local checkpoint/apply, parity, shadow projection,
and smoke verification remain mandatory operator gates.

## P13.4–P13.7 source guard implementation

The source-side policy and evidence state machine are implemented under
`backend/src/cutover/` and `backend/src/persistence/`, with the explicit operator journal command in
`backend/scripts/p13-cutover.ts`. The operator runbook is
`deploy/postgresql/p13/README.md`.

The implementation is deliberately non-mutating: it classifies actual workflow
states, validates immutable buffer/checkpoint evidence, enforces the exact
`16/jhcnetops:5433/jhc_netops` target, and records sequential cutover evidence.
It does not execute SQL, control PM2, deploy Edge Functions, or change authority.
The runtime authority selector requires an explicit value and refuses local mode
until the complete local application repository/outbox layer exists. A missing,
invalid, or partial local setting therefore cannot silently fall back to Supabase
writes.

Migration `007` now exists as unexecuted source and is protected by an explicit
dedicated-target check. Initial local profiles, runner-heartbeat,
inventory/target config, Health Watch, Traffic, and Managed Telemetry repositories
exist. Authenticated loopback routes for profiles and manual inventory/target
config are available to the server, but production main does not arm them yet.
Backend REST/RPC and runner Edge transports reject legacy application calls
before network when local authority is configured. This is deliberately partial:
the remaining local domain repositories, frontend/agent/Edge mutation routing,
and transactional Realtime shadow outbox are not implemented. The schema alone
can be imported but cannot safely become authoritative.

## P13.8–P13.9 verification closure

The source verifier is implemented in `backend/src/cutover/verification.ts` and is
available through the explicit `pre-cutover-verify` and
`post-cutover-verify` journal stages. It preserves three outcomes: `PASS`,
`FAIL`, and `UNKNOWN`; missing runtime evidence is never promoted to `PASS`.

The pre-cutover report binds the exact dedicated target, schema and migration
evidence, Batch 2 readiness, immutable final manifest/import, P12-derived final
data verification, identity dispositions, Checkpoint 2, and the still-Supabase
authority state. Its evidence hash must be recorded before Checkpoint 3 can be
armed.

The post-cutover report binds local authority and backend health, an internal
non-domain canary through the approved application path, the disabled legacy
Supabase mutation boundary, external Supabase Auth and shadow Realtime,
split-brain/outbox evidence, immutable release identity, and only the three
reviewed NetOps PM2 processes. The exact numbered operator procedure, browser
smoke checks, rollback triggers, and acceptance-state definitions are in
`deploy/postgresql/p13/README.md`.

P13 SOURCE READY remains **NO** until complete local repositories, the
transactional projection outbox, exhaustive old-writer guards, and the
internal cutover canary are implemented and reviewed. P13 DONE LIVE remains
**NO** until the complete Mini PC procedure passes.
