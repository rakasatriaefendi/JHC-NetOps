# JHC NetOps Local Backend

`backend/` adalah fondasi service lokal P9 yang nantinya menjadi trusted boundary
antara frontend, Local Runner, dan PostgreSQL lokal. Implementasi saat ini memakai
Fastify, ESM, TypeScript strict, dan Node.js 22.

## Development

```bash
npm ci
npm run dev
```

Perintah yang tersedia:

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm test
npm run lint
```

Salin `.env.example` menjadi `.env` hanya untuk konfigurasi lokal. Backend tetap
terikat ke loopback dan membutuhkan secret server-side berikut:

```text
HOST=127.0.0.1
PORT=3402
RUNNER_API_TOKEN=<shared random token, minimum 32 characters>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-side key>
```

Host non-loopback ditolak pada startup. File `.env` nyata diabaikan Git. Untuk
deployment mendatang, environment berada di luar release pada
`/var/www/jhc/jhc_noc/shared/backend/.env`; jangan membuat atau menyimpan file
production tersebut di repository.

## P10B: Runner recurring data plane

Endpoint lokal yang tersedia:

- `GET /healthz`, tanpa data konfigurasi;
- `POST /api/runner/heartbeat`, khusus Local Runner dengan header
  `Authorization: Bearer <RUNNER_API_TOKEN>`;
- `POST /api/runner/network-health`, untuk target, state, minute sample, dan
  event transisi Health Watch;
- `POST /api/runner/traffic`, untuk session, snapshot, flow batch, storage guard,
  dan lease Traffic;
- `POST /api/runner/managed-telemetry`, untuk target, device/interface state,
  alert transition, dan Observed LAN Hosts.

Backend memakai service-role key hanya di sisi server untuk menjembatani recurring
runner data plane ke tabel/RPC Supabase yang sudah ada. Kontrak, bounds, recovery,
deduplication, dan state-transition semantics mengikuti Edge Function sebelumnya.
Credential tidak dikirim ke browser atau dikembalikan oleh API.

Aktifkan jalur lokal pada environment runner dengan kedua nilai berikut:

```text
LOCAL_BACKEND_URL=http://127.0.0.1:3402
LOCAL_BACKEND_TOKEN=<same shared token>
```

Jika keduanya kosong, seluruh recurring data plane memakai Edge Function lama
sebagai rollback mode. Konfigurasi parsial ditolak. Setelah jalur lokal dipilih,
kegagalan request tidak otomatis jatuh kembali ke Edge Function agar tidak terjadi
dual-write atau event ganda. Manual Ping, Discovery, Device Inspector, LAN
Diagnostics, dan control-plane lain tetap memakai Edge Function.

Rollback terkontrol: hentikan runner, kosongkan kedua `LOCAL_BACKEND_*`, mulai
runner kembali, verifikasi loop recurring sehat lewat Edge, lalu backend lokal
boleh dihentikan. Jangan mengganti mode ketika operasi masih berjalan.

P11 baru akan mengganti repository Supabase dengan PostgreSQL lokal. P10B belum
memigrasikan database, Auth, Realtime, frontend, admin, atau browser API.

## P10C: local Asset Inventory foundation

Asset Inventory uses `GET /api/assets` and `GET /api/assets/:id`. These routes
are enabled only when `DATABASE_URL` and `FRONTEND_API_TOKEN` are both present.
The DSN is rejected unless it targets the isolated loopback database
`jhc_netops_app@127.0.0.1:5433/jhc_netops`; this prevents accidental use of the
shared PostgreSQL `16/main` cluster on port 5432. Query parameters, response size,
database pool, statement duration, and errors are bounded.

The browser never calls these routes directly. An approved-user Next.js Server
Component calls them with the separate server-only token. Existing runner routes
continue to use `RUNNER_API_TOKEN` and existing Supabase repositories unchanged.
See `deploy/postgresql/README.md` for the future provisioning and rollback plan.

The dedicated cluster/database may already exist before schema acceptance. In
that case `provision-jhcnetops-cluster.sh` is a validating no-op and
`provision-jhcnetops-application.sh` reconciles only the two NetOps roles and the
`jhc_netops` database contract. `npm run test:postgres:assets` is an explicit,
read-only integration test outside the normal test glob; it skips unless both its
opt-in marker and dedicated test DSN are supplied.

## P10D1: bounded Asset Intelligence ingestion

When `/api/assets` is requested, the backend may refresh the local inventory at
most once per 30 seconds. The adapter reads only existing normalized Supabase
evidence from network inventory, saved Device Inspector fingerprints, Health
Watch latest state, Managed SNMP latest state, and Observed LAN Hosts. It does
not start a probe or scanner. Evidence is bounded, classified conservatively,
consolidated by a stable node/source key, and written with one parameterized
PostgreSQL bulk upsert. Refresh failure is non-destructive: retained local rows
remain available.

Migration `002_asset_intelligence.sql` adds hostname, bounded ports/services,
latency, evidence time, and the idempotent stable source key.

## P10D1-B: explicit active inventory scan

The same loopback backend exposes `GET/POST /api/assets/scan` and
`DELETE /api/assets/scan/:id` under the existing frontend server token. A scan
can target only an enabled database-configured canonical RFC1918 IPv4 CIDR
(maximum eight networks and 1,024 addresses each). `ASSET_SCAN_NETWORKS` is
imported only once as bootstrap compatibility and never overwrites later operator
configuration.

Quick Discovery runs one fixed discovery operation. Deep Scan follows discovery
with fixed per-host fingerprint operations, default concurrency 4 (hard maximum
8), a 45-second host deadline, and a 120-second discovery deadline. Only one run
is active; cancellation aborts child processes, and startup marks interrupted
runs failed. XML is parsed and normalized in memory; raw XML is never persisted.
See `../docs/P10D1B_ACTIVE_INVENTORY_SCAN.md` for the privilege and rollout model.

## P10D3: scan-network settings and routed networks

Migration `005_scan_network_settings.sql` adds the soft-deletable allowlist and a
durable bootstrap marker. Explicit `/api/assets/scan-networks` routes list,
detect, route-test, create, update, and delete settings. Detection uses structured
iproute2 output and may fail without blocking manual configuration. Route tests
perform one kernel lookup only. Direct Quick scans retain ARP discovery; routed
Quick scans use a separate fixed bounded non-ARP-only helper mode. Details and
the pending Mini PC checklist are in `../docs/P10D3_SCAN_NETWORK_SETTINGS.md`.

## P10D2: bounded Asset Change History

Migration `004_asset_change_history.sql` adds append-only normalized history.
Asset reconciliation and its event write share one PostgreSQL transaction;
per-stable-key advisory locks and a deterministic unique event key make retries
safe. Read-only history is exposed through `GET /api/assets/events` and
`GET /api/assets/:id/events` using the existing frontend-server bearer token.
See `../docs/P10D2_ASSET_CHANGE_HISTORY.md` for exact semantics and the pending
Mini PC acceptance checklist.
