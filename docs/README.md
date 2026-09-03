# Project Documentation

Folder ini menyimpan sumber kebenaran dan panduan operasional project.

## Urutan baca untuk developer dan AI assistant

1. [PRD.md](PRD.md) — tujuan, arsitektur, skema data, dan roadmap.
2. [AGENTS.md](AGENTS.md) — aturan implementasi dan batas keamanan.
3. [DESIGN.md](DESIGN.md) — token serta aturan UX/UI.
4. [PLANNING.md](PLANNING.md) — checklist dan status pekerjaan.
5. [HANDOVER.md](HANDOVER.md) — gambaran sistem aktual, instalasi, operasi,
   troubleshooting, dan checklist serah terima.

Jangan menyimpang dari dokumen tersebut tanpa persetujuan pemilik project.

## Panduan setup dan operasi

| Dokumen | Isi |
|---|---|
| [AGENT_SETUP.md](AGENT_SETUP.md) | Setup Supabase, WSL agent, runner, diagnostics, Traffic, Health Watch, dan Discovery. |
| [AUTH_SETUP.md](AUTH_SETUP.md) | Environment auth, migration, seed admin, dan verifikasi approval. |
| [PANDUAN.md](PANDUAN.md) | Panduan penggunaan harian LAN Diagnostics dan runner. |
| [PORTABLE_DEVELOPMENT.md](PORTABLE_DEVELOPMENT.md) | Fixture Managed Telemetry lokal yang eksplisit, read-only, dan terisolasi dari data produksi. |
| [UBUNTU_DEPLOYMENT_READINESS.md](UBUNTU_DEPLOYMENT_READINESS.md) | Status adapter P8A native Ubuntu, konfigurasi ZIP-release, dan gap validasi/always-on Mini PC. |

## Design references

Folder `stitch_netops_monitoring_interface` berisi HTML dan screenshot referensi UI.
Referensi tersebut tidak mengalahkan token atau keputusan pada `DESIGN.md`.

Arsip `files.zip` dan folder backup dokumentasi lama bersifat lokal dan diabaikan
Git. Gunakan dokumen aktif pada folder ini sebagai acuan implementasi.
