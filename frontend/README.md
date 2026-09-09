# Network Monitoring Frontend

Dashboard Next.js App Router untuk auth, monitoring, traffic visibility, history,
alerts, LAN Diagnostics, administration, Health Watch, dan Network Discovery.

Route `/assets` adalah fondasi P10C untuk inventaris lokal. Approved user
merender data melalui Next.js Server Component yang memanggil backend loopback
dengan `LOCAL_BACKEND_URL` dan `LOCAL_BACKEND_FRONTEND_TOKEN` server-only.
Browser tidak menerima koneksi PostgreSQL atau token tersebut; konfigurasi kosong
dan backend failure ditampilkan sebagai state lokal yang bounded.

P10D1 memperkaya route yang sama dengan satu Asset Insights yang collapsed,
tabel desktop ringkas (No, Status, IP, Hostname, MAC, Vendor, OS, Type, Ports),
kartu responsif, dan detail Overview/Network terpusat. Pilihan Insight memfilter
inventaris yang sama; tidak membuat tabel kedua atau memulai operasi jaringan.

## Stack

- Next.js 16 dan React 19.
- TypeScript.
- Tailwind CSS.
- Supabase SSR/client dan Realtime.

## Routes

| Route | Fungsi |
|---|---|
| `/dashboard` | Traffic summary, Network Health Watch, dan Discovery Operator/Admin. |
| `/traffic` | Bounded Live Traffic dan flow metadata. |
| `/history` | Riwayat diagnostic serta trend. |
| `/alerts` | Event aktif dan status jaringan. |
| `/diagnostics` | One-click bandwidth dan Layer-3 path diagnostics. |
| `/devices` | Satu daftar inventory perangkat dengan konfigurasi Health Watch kontekstual. |
| `/snmp` | Latest device/interface telemetry dan Observed LAN Hosts terlebih dahulu, lalu konfigurasi Managed SNMP. |
| `/assets` | Inventaris Aset lokal, Insights berbasis evidence, dan detail Overview/Network. |
| `/admin` | Approval dan pengelolaan akses user. |

Route protected memerlukan profile Supabase berstatus internal `approved` (label UI
Aktif). Operasi jaringan seperti start/stop capture, discovery, dan pengelolaan
target tersedia untuk Operator/Admin; administrasi akun tetap khusus Admin.

## Environment

```powershell
Copy-Item .env.example .env.local
```

Isi:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SITE_URL`, gunakan `http://localhost:3000` saat development.

Jangan pernah menaruh service-role key pada frontend atau variabel `NEXT_PUBLIC_*`.

## Development

```powershell
npm ci
npm run dev
```

Untuk fixture frontend tanpa perangkat SNMP nyata, ikuti
[PORTABLE_DEVELOPMENT.md](../docs/PORTABLE_DEVELOPMENT.md). Mode tersebut default
OFF dan hanya tersedia saat development.

## Quality checks

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

## Design rules

UI mengikuti [DESIGN.md](../docs/DESIGN.md): Inter untuk UI, JetBrains Mono untuk
data teknis, token warna Tailwind, serta status yang selalu memakai icon dan label.
Jangan hardcode warna baru di komponen tanpa memperbarui design system.

Frontend hanya membuat request/job terstruktur. Ia tidak boleh mengeksekusi shell,
menentukan arbitrary capture filter, atau mengirim arbitrary subnet/target ke runner.
