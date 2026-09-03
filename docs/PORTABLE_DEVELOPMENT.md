# Portable Development Mode

Portable Development Mode menyediakan data Managed Telemetry dan Observed LAN
Hosts sintetis yang deterministik untuk pengembangan UI lokal tanpa akses ke
jaringan JHC atau perangkat SNMP nyata.

Mode ini **bukan** emulator SNMP, bukan pengganti validasi perangkat nyata, dan
tidak menjalankan collector, polling, scan, atau autentikasi SNMP. Fixture tidak
boleh dianggap sebagai telemetry produksi.

## Mengaktifkan

Jalankan frontend sebagai development server dengan environment lokal:

```powershell
$env:PORTABLE_DEV_MODE = "true"
$env:PORTABLE_DEV_SCENARIO = "healthy"
npm.cmd run dev
```

Scenario yang tersedia:

- `healthy`
- `partial`
- `alert_recovery`
- `large_observed_hosts`

`PORTABLE_DEV_SCENARIO` opsional dan default-nya `healthy`. Mode hanya aktif
ketika `NODE_ENV=development` dan `PORTABLE_DEV_MODE=true`. Production build
selalu memakai data Supabase meskipun variable tersebut tidak sengaja tersedia.

Workspace `/snmp` dan halaman Observed LAN Hosts menampilkan indikator
**Portable fixture data**. Konfigurasi target dibuat read-only selama mode ini
aktif. Fixture berasal dari repository frontend dan tidak dipublish ke Edge
Function atau tabel Supabase.

## Menonaktifkan

Hapus variable atau set ke `false`, lalu restart development server:

```powershell
Remove-Item Env:PORTABLE_DEV_MODE -ErrorAction SilentlyContinue
Remove-Item Env:PORTABLE_DEV_SCENARIO -ErrorAction SilentlyContinue
```

Default selalu OFF. Auth dan tooling frontend normal masih dapat membutuhkan
Internet, tetapi fixture tidak membutuhkan jaringan JHC. Jangan menyimpan
credential, data rumah sakit, atau identifier infrastruktur nyata di fixture.
Implementasi collector/OID/auth/counter/alert SNMP tetap tidak berubah.
