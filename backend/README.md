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

## P10A: Runner heartbeat

Endpoint lokal yang tersedia:

- `GET /healthz`, tanpa data konfigurasi;
- `POST /api/runner/heartbeat`, khusus Local Runner dengan header
  `Authorization: Bearer <RUNNER_API_TOKEN>`.

Backend memakai service-role key hanya di sisi server untuk menjembatani heartbeat
ke tabel Supabase yang sudah ada. Route tetap menjalankan recovery stale Traffic
session seperti implementasi Edge Function. Tidak ada credential ini yang dikirim
ke browser atau dikembalikan oleh API.

Aktifkan jalur lokal pada environment runner dengan kedua nilai berikut:

```text
LOCAL_BACKEND_URL=http://127.0.0.1:3402
LOCAL_BACKEND_TOKEN=<same shared token>
```

Jika keduanya kosong, heartbeat tetap memakai `diagnostic-jobs` Edge Function
sebagai rollback path. Konfigurasi parsial ditolak. Setelah jalur lokal dipilih,
kegagalan request tidak otomatis jatuh kembali ke Edge Function agar tidak terjadi
double write. Seluruh operasi runner selain heartbeat masih memakai Edge Function
Supabase yang lama.

P11 baru akan mengganti implementasi `RunnerHeartbeatRepository` dengan PostgreSQL
lokal; P10A belum memperkenalkan PostgreSQL lokal, ORM, user auth, atau browser API.
