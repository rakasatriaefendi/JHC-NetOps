# JHC NetOps Monitor

JHC NetOps Monitor adalah dashboard dan runtime operasi jaringan internal. Runtime
aktif bersifat local-only:

```text
Browser -> Next.js -> Fastify loopback -> PostgreSQL 16/jhcnetops:5433
                     ^
                     +-- Local Runner -> Python agent

PostgreSQL LISTEN/NOTIFY -> Fastify SSE -> same-origin Next route -> Browser
```

Local Auth, PostgreSQL, dan local realtime merupakan authority tunggal. Browser
tidak menerima DSN, bearer token backend, atau alamat loopback. Runner dan agent
tidak mempunyai fallback remote dan tidak melakukan dual-write.

## Komponen

| Folder | Fungsi |
|---|---|
| [`frontend`](frontend/README.md) | Next.js App Router, Local Auth, UI, dan proxy SSE same-origin. |
| [`backend`](backend/README.md) | Fastify loopback, repository PostgreSQL, runner API, dan realtime broker. |
| [`runner`](runner/README.md) | Orkestrasi job lokal untuk Windows/WSL dan native Ubuntu. |
| [`agent`](agent/README.md) | Collector Python, diagnostics, dan Traffic Live header-only. |
| [`deploy`](deploy/postgresql/README.md) | Launcher dan prosedur deployment yang direview. |
| [`supabase`](supabase/README.md) | Migration historis immutable saja; bukan runtime atau deployment aktif. |
| [`docs`](docs/README.md) | Desain, handover, runbook, dan riwayat fase. |

## Development

Salin hanya environment example komponen yang diperlukan. File environment,
config runner lokal, build output, log, dan data runtime tidak boleh di-commit.

```powershell
Copy-Item frontend\.env.example frontend\.env.local
Copy-Item backend\.env.example backend\.env
Copy-Item runner\.env.example runner\.env

npm.cmd --prefix backend ci
npm.cmd --prefix frontend ci
npm.cmd --prefix runner ci
```

Agent Linux:

```bash
cd agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
```

Quality gates yang direview operator:

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix backend run typecheck
npm.cmd --prefix backend run lint
npm.cmd --prefix backend run build
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run typecheck
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
npm.cmd --prefix runner test
```

## Batas keamanan

- Jangan simpan raw PCAP, packet payload, cookie, token, credential, atau data pasien.
- Operasi aktif hanya boleh memakai target/CIDR yang sudah diotorisasi dan bounded.
- Credential SNMP tetap lokal pada runner; aplikasi hanya menyimpan referensi profil.
- PostgreSQL `16/main:5432` dan database proyek lain tidak boleh disentuh.
- Startup aplikasi tidak menjalankan migration otomatis.

## Bukti historis dan rollback

`backend/migrations/001-015`, `supabase/migrations/**`, tooling P12/P13, serta
dokumen fase lama dipertahankan sebagai bukti immutable. Mereka bukan petunjuk
runtime aktif. Rollback menggunakan release immutable yang sudah direview dan
runbook fasenya; tidak ada compatibility switch atau fallback remote dalam source
aktif. Penghapusan project remote baru boleh dilakukan setelah P16.4 diterima.
