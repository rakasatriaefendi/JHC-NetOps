# JHC NetOps Local Backend

Fastify berjalan pada loopback dan menjadi satu-satunya application boundary ke
PostgreSQL NetOps. Runtime hanya menerima `PERSISTENCE_AUTHORITY=local_postgres`;
nilai kosong atau selain itu gagal tertutup. Tidak ada remote repository,
fallback, atau dual-write.

## Environment

Salin `.env.example` menjadi `.env` lokal. Nilai rahasia tidak boleh di-commit.

- `HOST=127.0.0.1`
- `PORT=3402`
- `DATABASE_URL` untuk exact dedicated `16/jhcnetops:5433/jhc_netops`
- `RUNNER_API_TOKEN` untuk route runner
- `FRONTEND_API_TOKEN` untuk request server-side Next.js
- `PERSISTENCE_AUTHORITY=local_postgres`

Backend menolak host non-loopback dan target database yang tidak sesuai guard.
Frontend/browser tidak pernah menerima `DATABASE_URL` atau token backend.

## Runtime

- repository aplikasi membaca/menulis PostgreSQL lokal;
- runner memakai route `/api/runner/*` dengan bearer token khusus;
- frontend server memakai route `/api/application/*` dengan bearer token terpisah;
- Local Auth dan session disimpan di PostgreSQL;
- realtime memakai transactional `pg_notify`, dedicated `LISTEN`, dan SSE bounded;
- migration tidak dijalankan otomatis saat startup.

Outbox/watermark lama dan tooling P12/P13 tetap dipertahankan sebagai evidence.
Mereka tidak mengaktifkan shadow projection pada runtime local-only.

## P17-D2B bounded runner work wait

`POST /api/runner/work/wait` uses the existing runner bearer (not the frontend
token) and exactly `{ "runner_id": "<registered-runner-id>" }`, body limit 256
bytes. The response is `{ "data": { "runner_id": "...", "available": [],
"timed_out": true } }`; available kinds, in priority order, are `manual_ping`,
`traffic`, `discovery`, `device_inspector`. It never returns job assignments or
payloads. Identity is a validated, registered ID under the existing shared runner
bearer trust model, not a new per-runner credential system.

One wait per runner, 32 globally, waits about 10 seconds. Durable queue checks run
at registration and timeout, with additional checks after successful application
enqueue responses (repository transactions have already committed). Subscribe
before checking; revision tracking closes enqueue/check races. Hints coalesce to
at most one check per 100ms per waiter; known runner IDs wake only that runner.
Ping enqueue derives its runner in SQL, so its hint is a bounded broadcast.
Hints are process-local and non-durable: missed responses, multiple backend
processes or a restart are covered by the next durable check, not event replay.
Existing atomic claim routes remain the only assignment authority.

No PostgreSQL connection/transaction is held during the wait. Each short read or
maintenance transaction sets its own 3-second statement timeout; pool acquisition
is independently bounded. A final query can extend the nominal 10-second wait;
the runner uses a 20-second HTTP deadline. Only this authenticated wait disables
the socket's 5-second idle timeout and restores it afterward. Cancellation and
shutdown release waiters. Capacity/repository/shutdown failures return bounded
503 codes; unknown runner returns 403, authentication failure 401.

Expiry maintenance runs once at startup and every 10 seconds **after the prior
pass settles**, even without runners. One transaction updates at most 100 expired
rows per subsystem using `SKIP LOCKED`, preserving existing lease predicates and
terminal fields (Ping lease, Traffic 10m queued/30s stopping/45s running recovery,
Discovery and Inspector expiry). Failures log only a bounded category and retry
next pass. Large historical expiry backlogs drain over multiple passes. Candidate
read-only mode does not register this service or start maintenance. No migration,
new token, environment switch, or startup schema mutation is introduced.

Roll out **backend first**, retaining all old claim routes; the existing runner
continues working. Then upgrade the runner. A new runner receiving 404/405 for
work-wait uses the same authenticated local claim endpoints at its existing
control cadence, rechecking support after 60 seconds. Auth/503/network failures
never trigger a transport/auth downgrade. Rollback can restore the runner first;
rolling back the backend first is also compatible through that bounded fallback.
Do not change Health/SNMP intervals, capture privileges, or shared infrastructure.
These are source-level expectations; runtime acceptance is still required.

## P17-B asset identity

Migration 019 is an explicit prerequisite for this release; startup never applies
it. `asset.assets.id` is canonical, with `network_node_ref` retained as the
control-plane link (no reverse `network_nodes.asset_id` link). Ingestion resolves
explicit bindings, unique valid SNMP serials, then unique global MACs inside the
same transaction as asset/change-history and endpoint writes. Duplicate strong
evidence is recorded as conflict, never merged. IP-correlated neighbor `node_id`
is not an explicit binding; Observed Hosts membership/persistence is unchanged.

IP/weak-only observations use an immutable snapshot key (source/IP/MAC/timestamp,
plus scan-run UUID for active scans), not a cross-snapshot device identifier.
Retrying the same snapshot is idempotent; a new weak snapshot remains a distinct
provisional observation. No legacy IDs/keys are rewritten and no duplicate rows
are deleted. Long-term provisional retention/consolidation requires a later
reviewed policy, not an IP-only merge. Inputs retain the 1000 evidence/1024 scan
bounds; ambiguous candidate sets beyond the bounded lookup fail closed.

Endpoint moves close/open the timeline atomically, with a partial unique index
for current IP ownership. A per-evidence anchor preserves other interface
endpoints; the same recorded global MAC bridges a legacy node-binding endpoint
when it moves, without closing another asset's or another interface's endpoints.
Older evidence cannot displace newer current ownership. The read-only
Asset Detail panel exposes bounded evidence/history with explicit truncation.
Health/SNMP still execute against `network_nodes.ip_address`; P17-C fail-closed
monitoring identity binding is intentionally not implemented here. No engineID
is captured or manufactured.

## Commands

```bash
npm ci
npm run dev
npm test
npm run typecheck
npm run lint
npm run build
```

Preflight PostgreSQL bersifat read-only dan opt-in:

```bash
npm run preflight:postgres
```

Provisioning, migration, acceptance, dan rollback harus mengikuti runbook di
[`deploy/postgresql`](../deploy/postgresql/README.md). Jangan arahkan backend ke
PostgreSQL `16/main:5432`.
