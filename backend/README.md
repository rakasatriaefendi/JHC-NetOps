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
