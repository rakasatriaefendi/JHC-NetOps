# Portable Development Mode

Portable Development Mode menyediakan fixture Managed Telemetry dan Observed LAN
Hosts sintetis untuk pengembangan UI tanpa perangkat SNMP nyata. Mode ini bukan
emulator SNMP dan tidak menjalankan collector, poll, scan, atau autentikasi SNMP.

```powershell
$env:PORTABLE_DEV_MODE = "true"
$env:PORTABLE_DEV_SCENARIO = "healthy"
npm.cmd run dev
```

Scenario: `healthy`, `partial`, `alert_recovery`, dan
`large_observed_hosts`.

Mode hanya aktif ketika `NODE_ENV=development` dan flag bernilai `true`.
Production selalu memakai backend/PostgreSQL lokal authoritative. Workspace SNMP
menandai fixture dengan jelas dan membuat konfigurasi target read-only. Fixture
tidak dipersist, tidak memanggil backend mutation, dan tidak menjalankan operasi
jaringan.

Matikan dengan menghapus kedua variable dan restart development server. Jangan
memasukkan credential, data rumah sakit, atau identifier infrastruktur nyata ke
fixture.
