# Network Monitoring Frontend

Dashboard Next.js App Router untuk auth, monitoring, traffic visibility, history,
alerts, LAN Diagnostics, administration, Health Watch, dan Network Discovery.

## Stack

- Next.js 16 dan React 19.
- TypeScript.
- Tailwind CSS.
- Supabase SSR/client dan Realtime.

## Routes

| Route | Fungsi |
|---|---|
| `/dashboard` | Traffic summary, Network Health Watch, dan Discovery admin. |
| `/traffic` | Bounded Live Traffic dan flow metadata. |
| `/history` | Riwayat diagnostic serta trend. |
| `/alerts` | Event aktif dan status jaringan. |
| `/diagnostics` | One-click bandwidth dan Layer-3 path diagnostics. |
| `/devices` | Inventory perangkat dan konfigurasi Health Watch. |
| `/snmp` | Managed SNMP targets, device/interface telemetry, dan Observed LAN Hosts. |
| `/admin` | Approval dan pengelolaan akses user. |

Route protected memerlukan profile Supabase berstatus `approved`. Operasi sensitif
seperti start/stop capture, discovery, dan pengelolaan target dibatasi untuk admin.

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
