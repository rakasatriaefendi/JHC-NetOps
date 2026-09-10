# P10D2 Asset Change History

Date: 2026-09-09. Source implementation is complete; Mini PC runtime acceptance
is intentionally pending.

## Persistence semantics

`asset.change_events` is append-only application history. A newly inserted asset
gets one `created` event with `before_state = null` and empty `changed_fields`.
An existing asset gets at most one grouped `changed` event per reconciliation,
containing every changed allowlisted field. The current asset upsert and event
insert run in the same transaction. Stable-key advisory locks serialize competing
writers; deterministic SHA-256 `event_key` plus a unique constraint deduplicates
retries. Active scans retain their real `scan_run_id` and `active_scan` event
source even when stronger operator-owned asset fields remain authoritative;
non-scan reconciliation stores a null scan link and its factual evidence source.
Deleting an asset or scan later sets the reference null while the
historical stable key and event remain.

Snapshots contain only name, hostname, IP, MAC, vendor, platform, device type,
status, bounded open ports, and bounded detected services. Strings, MAC/vendor,
ports, and service order are canonicalized before comparison. Changes limited to
last-seen/evidence/update time, latency, confidence, array ordering, or service
ordering produce no event. A host absent from a scan is not changed or marked
offline. No raw scanner output, credential, token, or arbitrary fingerprint is
stored.

`status` remains in snapshots as monitoring context and legacy events that list
it remain readable, but it is not an Asset Change History field for new events.
A status-only transition emits no event; when status changes alongside identity,
address, platform, port, or service evidence, only those meaningful fields are
listed in `changed_fields`.

Existing assets receive no fabricated history because migration 004 performs no
backfill. Their first post-migration reconciliation has a real before row and
creates history only if a meaningful persisted value changes.

## Read and UI semantics

The loopback backend exposes authenticated, read-only
`GET /api/assets/events` and `GET /api/assets/:id/events`. Search and event/source/
changed-field filters are allowlisted; page sizes are 10, 25, or 50; ordering is
newest recorded time then UUID descending. Database failures return a generic
bounded error.

The `/history` Asset Changes tab renders created events and field-level before to
after values without raw JSON. Asset detail loads only that asset's history on
demand, avoiding inventory-table N+1 requests.

PERANGKAT BARU / NEW DEVICE is derived, not persisted and not a status. It is
shown when source is `active_scan`, `discovery`, or `observed_host`, `first_seen_at`
is factual, and its age relative to backend `server_time` is between zero and 24
hours inclusive. Manual/import/Inspector/telemetry sources do not qualify. The
badge expires automatically; the permanent `created` event remains.

## Pending Mini PC acceptance

- Apply migration 004 only to PostgreSQL `16/jhcnetops`, port 5433, database
  `jhc_netops`, during an approved change window.
- Verify existing assets receive no fabricated created events.
- Run one real Quick scan and verify a genuinely new host creates one event and
  displays the temporary badge.
- Run one real Deep scan and verify meaningful changes are grouped in one event.
- Repeat the identical Deep result and verify no duplicate event.
- Verify real `scan_run_id` linkage and concurrent evidence reconciliation.
- Verify the deployed backend/frontend read and responsive UI paths.
