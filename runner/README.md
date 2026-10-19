# Local Runner

P18 uses persistent authenticated WebSocket control in healthy operation, and
pauses scheduled Health/SNMP without visible approved dashboard presence. Install
runner dependencies with `npm ci` in the candidate release. See
[P18 policy, degraded fallback and rollout](../docs/P18_ZERO_IDLE.md); the P17 HTTP
behavior below remains the compatibility path, not healthy P18 standby.

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
Control-plane idle memakai authenticated `POST /api/runner/work/wait` dengan
opt-in `wait_seconds=60` (HTTP deadline 70 detik). Backend tetap mengecek antrean
durable setiap maksimal 10 detik tanpa HTTP tambahan agar hint yang hilang tidak
melewatkan lease Ping 30 detik. Respons timeout tanpa work tidak menjalankan
claim kosong. Work hint hanya memicu atomic claim lama untuk jenis yang tersedia,
dengan prioritas Manual Ping -> Traffic -> Discovery -> Device Inspector.
Loop tetap serial: Traffic yang sedang berjalan menahan claim/wait berikutnya
sampai selesai; snapshot dan stop handling agent tidak berubah. Manual Ping
tetap ditolak dengan `RUNNER_BUSY` ketika pekerjaan lain aktif.

Heartbeat, Health Watch dan SNMP tetap independen; probe 1800 detik tidak menjadi
claim 1800 detik atau berubah menjadi probe 10 detik. SIGINT/SIGTERM membatalkan
wait/backoff. Pekerjaan agent yang sudah berjalan tetap menyelesaikan jalur
bounded existing sebelum cleanup; tidak ada paralelisasi atau requeue baru.
HTTP 503/network/auth failure memakai exponential backoff berjitter (awal sekitar
0,8-1,2 detik, maksimum 30 detik), bukan fallback auth/transport. Hanya 404/405
menandakan backend lama: gunakan claim lokal dengan bearer yang sama setiap
`min(poll_interval_ms, 2000)` ms, dan cek dukungan wait lagi setelah 60 detik.
Backend D2B yang menolak field baru dengan `400 INVALID_WORK_WAIT` dinegosiasi
ke body lama (wait 10 detik/deadline 20 detik); quiet support dicoba kembali setelah
60 detik. Error 400 lain tidak dianggap compatibility. `--once` tetap satu
rangkaian claim bounded tanpa long wait.

Ekspektasi source (bukan benchmark): zero-target idle healthy sekitar 2 HTTP/menit
pada heartbeat 60 detik: satu wait dan satu heartbeat, dibanding baseline D2B
sekitar 9 HTTP/menit (6 wait + heartbeat + Health GET + SNMP GET). Heartbeat kini
membawa dua flag assignment enabled. Hanya empty watch tanpa cache/pending buffer
dan dengan hint explicit false yang fresh <=120 detik yang menekan GET kosong.
Target baru terdeteksi pada heartbeat berikutnya (biasanya <=60 detik + satu tick
lokal/latensi read), termasuk saat capture aktif. Hint hilang/invalid/stale
mengembalikan refresh/retry lama; cached targets tetap diproses normal. SNMP lokal
disabled tetap tidak membuat watch. Tidak ada perubahan heartbeat/freshness,
credential, probe 1800 detik, counter, enrichment, atau publish buffer.
Saat capture aktif, tidak ada wait/claim control-plane;
request snapshot dan stop tetap seperti sebelumnya. Saat backend terus gagal,
steady-state retry sekitar 2-2,5/menit ditambah ramp-up awal dan durasi HTTP.
Backend lama mempertahankan 90/120 claim/menit ditambah sekitar 1 support check
per menit. Deploy backend dahulu, lalu runner; rollback runner dahulu disarankan.
Semua endpoint claim lama tetap tersedia. Recovery lease kini juga dijalankan
backend secara bounded tanpa bergantung pada claim idle; lihat backend README.
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
