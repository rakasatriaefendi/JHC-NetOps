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

Salin `.env.example` menjadi `.env` hanya untuk konfigurasi lokal. Default aman:

```text
HOST=127.0.0.1
PORT=3402
```

Host non-loopback ditolak pada startup. File `.env` nyata diabaikan Git. Untuk
deployment mendatang, environment berada di luar release pada
`/var/www/jhc/jhc_noc/shared/backend/.env`; jangan membuat atau menyimpan file
production tersebut di repository.

## Batas P9

Endpoint yang tersedia hanya `GET /healthz`. Backend tidak terhubung ke Supabase
atau PostgreSQL, tidak menyediakan authentication maupun Realtime, dan belum
menjadi jalur data frontend/runner. Seluruh Supabase Edge Function yang ada tetap
authoritative dan perilaku aplikasi saat ini tidak berubah.

P10 akan memigrasikan kontrak Edge Function secara bertahap serta mendefinisikan
trusted runner authentication. P11 baru memperkenalkan PostgreSQL lokal.
