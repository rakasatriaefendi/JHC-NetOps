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
