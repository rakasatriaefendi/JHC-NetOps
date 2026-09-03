# Panduan Pemakaian LAN Diagnostics

Panduan ini dipakai dari root project `Network-Monitoring`.

Panduan ini khusus runtime development Windows + Ubuntu WSL yang saat ini
didukung. Untuk gambaran lintas komponen dan gap target Mini PC Ubuntu P8, baca
[HANDOVER.md](HANDOVER.md).

## Jawaban singkat

Tidak perlu menjalankan `task.ps1` setiap kali mau melakukan diagnostik.

- `install` dijalankan **satu kali** saat setup awal.
- Setelah terpasang, Windows Task Scheduler otomatis menjalankan runner setiap
  kali user login Windows.
- Sebelum test harian, cukup pastikan card **Runner Health** menunjukkan
  `ONLINE`.
- Jika `OFFLINE`, jalankan action `start`, tunggu 10–30 detik, lalu refresh UI.

## Cara paling mudah — satu command

Dari PowerShell di root project, jalankan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-diagnostics.ps1
```

Jika command `python` tersedia di Windows, command singkat berikut juga boleh
dipakai dan akan otomatis meneruskan eksekusi ke launcher WSL yang sama:

```powershell
python scripts\start_diagnostics.py
```

Tidak perlu menjalankan `.venv/Scripts/activate`. Project tidak membuat
virtualenv Python Windows di root; virtualenv yang dipakai runner berada di
`agent/.venv` dalam WSL dan dipilih otomatis oleh launcher.

Command tersebut menjalankan `scripts/start_diagnostics.py` memakai Python 3.12
dari persistent virtualenv WSL. Script akan otomatis:

1. membaca konfigurasi runner dan environment lokal;
2. memeriksa apakah Task Scheduler sudah terpasang;
3. memasang task jika belum ada;
4. menjalankan runner jika belum aktif;
5. menunggu heartbeat Supabase maksimal 35 detik; dan
6. menampilkan `ONLINE` jika LAN Diagnostics siap digunakan.

Windows host saat ini tidak memiliki Python native, sehingga file PowerShell di
atas hanya menjadi launcher untuk Python virtualenv project di WSL. Script ini
tidak menjalankan test bandwidth otomatis; test tetap hanya berjalan setelah
kamu menekan **Jalankan diagnostik** di UI.

Command yang sama juga menyalakan runner untuk halaman **Traffic**. Setelah
status runner `ONLINE`, refresh `/traffic`; capability `traffic_live` akan
terbit lewat heartbeat yang sama.

## 1. Setup pertama kali — cukup sekali

Pastikan `runner/config.local.json` dan environment file lokal sudah benar, lalu
jalankan PowerShell dari root project:

```powershell
node runner\src\main.mjs --preflight-only
powershell -ExecutionPolicy Bypass -File runner\task.ps1 install
powershell -ExecutionPolicy Bypass -File runner\task.ps1 start
```

Cek hasilnya:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 status
node runner\scripts\backend-status.mjs
```

Kondisi yang benar:

- `State` Task Scheduler adalah `Running`.
- `online` dari `backend-status.mjs` adalah `true`.
- `heartbeat_age_seconds` normalnya di bawah 30 detik.
- Card Runner Health di `/diagnostics` menjadi `ONLINE`.

Task tetap berjalan saat laptop memakai baterai dan tidak mempunyai execution
timeout. WSL tidak perlu dibuka manual; runner menjalankannya dengan
`wsl.exe --exec` saat ada job.

## 2. Pemakaian harian

1. Sambungkan laptop ke jaringan yang ingin diuji.
2. Pastikan tipe koneksi sebenarnya:
   - Terhubung lewat WiFi: pilih `WiFi`.
   - Terhubung lewat kabel fisik: pilih `Ethernet`.
   - Jangan memilih Ethernet jika laptop sebenarnya masih memakai WiFi.
3. Buka aplikasi. Jika frontend dijalankan lokal dan belum aktif:

   ```powershell
   npm.cmd --prefix frontend run dev
   ```

   Jika frontend sudah di-deploy, cukup buka URL deployment.

4. Buka menu **LAN Diagnostics**.
5. Pastikan **Runner Health = ONLINE**.
6. Pilih source location, target, connection type, dan durasi.
7. Klik **Jalankan diagnostik** satu kali dan tunggu sampai status `completed`.
8. Periksa upload, download, timestamp, dan tabel hop MTR.

## 3. Jika runner OFFLINE

Cek Task Scheduler:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 status
```

Jika `State` bukan `Running`, jalankan:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 start
```

Tunggu 10–30 detik, lalu cek heartbeat dan refresh browser:

```powershell
node runner\scripts\backend-status.mjs
```

Jika task belum terdaftar atau muncul error `task not found`:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 install
powershell -ExecutionPolicy Bypass -File runner\task.ps1 start
```

Jika task berjalan tetapi heartbeat tetap offline, jalankan preflight:

```powershell
node runner\src\main.mjs --preflight-only
```

Periksa safe error code yang muncul, misalnya `WSL_DISTRO_NOT_FOUND`,
`AGENT_VENV_MISSING`, `IPERF3_MISSING`, atau `MTR_MISSING`.

## 4. Localhost vs target LAN nyata

Target `Localhost — TEST ENVIRONMENT` hanya untuk memastikan pipeline runner,
WSL, iperf3, MTR, Supabase, dan UI bekerja. Angka Mbps localhost bukan performa
WiFi, Ethernet, atau LAN.

Untuk test LAN nyata, sebelum menjalankan diagnostik pastikan:

1. Target sudah mendapat izin dari pemilik jaringan/server.
2. Target telah ditambahkan ke allow-list `runner/config.local.json`.
3. `iperf3 -s` berjalan pada server target dan port yang disetujui.
4. Firewall mengizinkan koneksi dari laptop penguji.
5. IP/hostname target dapat dijangkau dari lokasi pengujian.

### Menambahkan target LAN ke allow-list

`Source location` pada halaman LAN Diagnostics adalah **label lokasi fisik**,
misalnya `Lantai 3 - Ruang IT`, bukan alamat IP. IPv4 sumber, adapter, gateway,
dan tipe koneksi diambil otomatis dari route Windows menuju target.

Setelah IP server dan izin pengujian dikonfirmasi, jalankan dari root project:

```powershell
python scripts\configure_diagnostic_target.py add --id server-253 --label "Server 253" --ip 192.168.10.253 --port 5201
```

Alamat IPv4 harus ditulis lengkap memakai empat oktet. Tool memvalidasi setiap
oktet `0-255`, hanya menerima alamat private RFC1918, menolak ID/IP duplikat,
dan membuat backup `runner/config.local.json.bak` sebelum menulis config.
Auto-titik setiap tiga digit tidak dipakai karena panjang oktet IPv4 bisa satu
sampai tiga digit, misalnya `10.0.0.5`.

Lihat allow-list saat ini:

```powershell
python scripts\configure_diagnostic_target.py list
```

Restart runner agar config baru dimuat dan dipublikasikan ke dropdown:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 restart
```

Refresh halaman `/diagnostics`. Dropdown akan menampilkan label dan IP target.
Jika target tidak dipakai lagi, nonaktifkan tanpa menghapus riwayat config:

```powershell
python scripts\configure_diagnostic_target.py disable server-253
powershell -ExecutionPolicy Bypass -File runner\task.ps1 restart
```

Target LAN nyata saat ini masih menunggu otorisasi. Jangan mengganti target
localhost dengan perangkat kantor tanpa izin.

## 5. Cara membaca hasil

- WiFi adalah hasil end-to-end client-ke-server, bukan bukti bottleneck LAN kabel.
- Untuk investigasi kabel, switch/uplink, atau segmen LAN, prioritaskan pengukuran
  Ethernet fisik dari lokasi yang sama.
- MTR hanya memperlihatkan hop Layer 3 yang merespons, bukan setiap switch Layer 2.
- Hasil hanya menunjukkan *suspected bottleneck* dan tidak membuktikan perangkat
  tertentu rusak tanpa bukti tambahan.

## 6. Menghentikan atau menghapus auto-start

Menghentikan task sementara:

```powershell
Stop-ScheduledTask -TaskName "Network Monitoring Local Runner"
```

Menghapus auto-start:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 remove
```

Setelah dihapus, jalankan `install` dan `start` lagi jika ingin mengaktifkannya.

## 7. Live Traffic

1. Jalankan command satu kali di bagian awal panduan dan pastikan runner `ONLINE`.
2. Buka `/traffic`, lalu pastikan indikator menunjukkan:
   - `RUNNER ONLINE`
   - `CAPTURE STOPPED`
   - `Capture scope: This Device`
3. Admin memilih durasi 5/10/15/30 menit lalu menekan **Start capture**.
4. Tunggu status `CAPTURE LIVE`; snapshot normalnya muncul sekitar dua detik.
5. Tekan **Stop capture** setelah selesai. Backend dan agent tetap menerapkan
   batas maksimum walaupun browser ditutup tanpa menekan Stop.

Viewer approved hanya dapat membaca snapshot dan tidak melihat kontrol start/stop.
Traffic berisi metadata header IPv4 TCP/UDP/ICMP saja; tidak menyimpan payload,
PCAP, URL, DNS query content, credential, atau data aplikasi/pasien.

Jika muncul `Traffic operation is not authorized by runner`, restart runner agar
heartbeat menerbitkan capability terbaru:

```powershell
Stop-ScheduledTask -TaskName "Network Monitoring Local Runner"
powershell -ExecutionPolicy Bypass -File runner\task.ps1 start
```

Tunggu 10–30 detik dan refresh `/traffic`. Jika runner sempat `degraded` saat
login Windows karena mount WSL/OneDrive belum siap, runner mencoba preflight
ulang secara terbatas; jalankan `start-diagnostics.ps1` bila tetap offline.
