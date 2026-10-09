# Local Runner

Runner mengorkestrasi job NetOps pada Windows/WSL atau native Ubuntu dan
berkomunikasi hanya dengan Fastify loopback.

## Konfigurasi

- `LOCAL_BACKEND_URL` harus menunjuk loopback backend.
- `LOCAL_BACKEND_TOKEN` adalah bearer token runner dan tidak boleh dicetak.
- `PERSISTENCE_AUTHORITY` harus `local_postgres`.
- `config.local.json`/config production berisi allow-list target dan profil
  credential lokal; file nyata tidak boleh di-commit.

Konfigurasi kosong, parsial, atau authority lain gagal tertutup. Tidak ada remote
fallback atau dual-write.

## Runtime

Runner mempertahankan heartbeat, Health Watch, Traffic, Managed Telemetry,
Discovery, Device Inspector, Manual Ping, dan diagnostics melalui route lokal yang
bounded. Perintah agent tetap terstruktur; browser tidak dapat memasok command,
subnet, OID, timeout, atau capture filter arbitrer.

Monitoring target memakai preset Aggressive (15/30/60 detik), Moderate
(900 detik, default target baru), atau Resource Saver (1800 detik). Interval
Health/SNMP mengatur probe/poll target, bukan claim loop atau heartbeat.
Contoh deployment memakai `poll_interval_ms=60000` dan
`heartbeat_interval_ms=60000`; validasi keduanya tetap 1000-60000 ms.
Claim control-plane memakai `min(poll_interval_ms, 2000)` ms di antara iterasi,
tanpa mengubah heartbeat atau interval Health/SNMP. Loop tetap serial: Traffic
yang sedang berjalan menahan claim berikutnya sampai selesai; Manual Ping
ditolak dengan `RUNNER_BUSY` ketika ada pekerjaan aktif, bukan dijalankan paralel.
Saat idle, maksimal satu rangkaian claim setiap 2 detik pada config 60000 ms;
latensi HTTP dan pekerjaan aktif tetap menambah waktu tunggu.
Scheduler internal 1 detik hanya memeriksa pekerjaan yang sudah jatuh tempo;
baseline counter SNMP tetap relatif terhadap interval target. Timeout SNMP
tidak diubah. Perubahan interval diterapkan saat target di-refresh (hingga
60 detik); pekerjaan yang sudah berjalan tetap diselesaikan secara bounded.

Record 15/30/60 yang ada tetap Aggressive tanpa rewrite otomatis. Interval
Health kustom lama dalam rentang 15-3600 tetap dapat dibaca/dijalankan; form
edit memilih Moderate jika nilai tidak termasuk preset dan hanya menyimpan
perubahan setelah submit. SNMP 900/1800/15 memerlukan migration 018 yang
diterapkan operator terlebih dahulu. UI Operator hanya dapat mengubah interval
SNMP; konfigurasi penuh/assignment credential dan delete tetap Admin-only.
Preset tidak memperbarui target lama ke 900 secara otomatis: operator harus
memilih Moderate/Resource Saver untuk mengurangi aktivitas target tersebut.

Freshness heartbeat frontend (Discovery, Diagnostics, dan Traffic) serta gate
control-plane backend memakai toleransi tetap 120 detik. Heartbeat 60 detik
tetap fresh di antara pengiriman, dengan satu interval tambahan sebagai grace.
Tanpa heartbeat baru, runner menjadi stale setelah usia heartbeat melewati
120 detik saat predicate dievaluasi; status online/capability tetap diperlukan.
Toleransi ini tidak mengubah preset, cadence claim loop, atau konfigurasi produksi.

Windows:

```powershell
npm.cmd ci
npm.cmd test
powershell -ExecutionPolicy Bypass -File task.ps1 status
```

Native Ubuntu memakai launcher `deploy/run-runner.sh` dan config shared yang
direview. Credential SNMP hanya di-resolve di runner dan tidak dikirim ke browser,
database, atau log.
