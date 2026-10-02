# Network Monitoring Frontend

Next.js App Router untuk dashboard, Network Health, Traffic, diagnostics,
Discovery, Device Inspector, Managed SNMP, Asset Inventory, Medical Equipment,
administrasi, dan reporting.

Runtime frontend bersifat local-only:

- Local Auth/session dan profile approval melalui backend lokal;
- semua application read/write dilakukan server-side ke backend loopback;
- browser hanya memakai route same-origin;
- realtime browser memakai `/api/realtime/events`, yang mem-proxy SSE tanpa
  mengekspos URL loopback atau bearer token;
- invalidation selalu diikuti refetch authoritative, bukan merge row payload.

## Environment

```powershell
Copy-Item .env.example .env.local
```

Environment server-side mencakup URL/token backend lokal. Jangan memakai prefix
`NEXT_PUBLIC_` untuk secret, DSN, atau token backend.

## Development dan quality gates

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

## Authorization dan keamanan

Route protected membutuhkan profile lokal berstatus `approved`. Operasi jaringan
tersedia untuk role yang diizinkan; administrasi akun tetap Admin-only. Frontend
hanya membuat request terstruktur dan tidak boleh mengeksekusi shell, menerima
arbitrary target, atau mengendalikan flag probe/capture.

UI mengikuti [`docs/DESIGN.md`](../docs/DESIGN.md). Fixture development yang
tidak melakukan probe nyata dijelaskan di
[`docs/PORTABLE_DEVELOPMENT.md`](../docs/PORTABLE_DEVELOPMENT.md).
