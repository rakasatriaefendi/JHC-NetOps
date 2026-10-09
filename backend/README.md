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
