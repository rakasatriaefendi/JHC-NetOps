# Native Ubuntu always-on deployment

Dokumen ini menjelaskan model deployment P8B yang sudah disiapkan di repository.
Ia bukan catatan bahwa service telah dipasang. Instalasi, `sudo`, `daemon-reload`,
enable, start, dan restart pada Mini PC harus dilakukan manual setelah review.

## Runtime yang dituju

- host Ubuntu 24.04, user/group non-root `mini-pc`;
- release aktif: `/var/www/jhc/jhc_noc/current`;
- release versi: `/var/www/jhc/jhc_noc/releases/<commit>`;
- konfigurasi runner: `/var/www/jhc/jhc_noc/shared/runner/config.json`;
- environment runner: `/var/www/jhc/jhc_noc/shared/runner/.env`;
- environment frontend: `/var/www/jhc/jhc_noc/shared/frontend/.env`;
- environment backend: `/var/www/jhc/jhc_noc/shared/backend/.env`;
- branding laporan: `/var/www/jhc/jhc_noc/shared/branding`;
- state runner: `/var/www/jhc/jhc_noc/shared/state`;
- log aplikasi runner: `/var/www/jhc/jhc_noc/shared/logs`;
- Node: `/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node`.

Unit tidak bergantung pada shell interaktif atau inisialisasi NVM. Frontend bind
hanya ke `192.168.1.130:3401`, bukan `0.0.0.0` atau IPv6 `::`.

## File repository

- `deploy/systemd/jhc-netops-runner.service`
- `deploy/systemd/jhc-netops-frontend.service`
- `deploy/run-runner.sh`
- `deploy/run-frontend.sh`
- `deploy/run-backend.sh`
- `deploy/ecosystem.config.cjs`
- `deploy/build-frontend.sh`
- `deploy/check-frontend-port.mjs`
- `deploy/runner-config.example.json`

Salin contoh konfigurasi menjadi file permanen bernama `config.json` di
`shared/runner`; jangan menamai konfigurasi permanen `config.acceptance.json`.
Contoh sengaja tidak berisi credential profile atau target aktif. Isi hanya
target dan profile yang sudah diotorisasi, lalu batasi izin baca file untuk
account service. Contoh deployment permanen mengaktifkan `enable_manual_ping`
agar action PING admin pada Dashboard/Reachability Map memakai alur ICMP bounded
yang sudah ada. Action tetap hanya dapat memakai Health Watch target yang
diotorisasi dan tidak menerima IP atau parameter ping dari browser. Nilai
`native_project_root` harus tetap:

```json
{
  "native_project_root": "/var/www/jhc/jhc_noc/current",
  "enable_manual_ping": true,
  "enable_snmp_telemetry": true,
  "environment_file": "/var/www/jhc/jhc_noc/shared/runner/.env",
  "data_directory": "/var/www/jhc/jhc_noc/shared/state",
  "log_directory": "/var/www/jhc/jhc_noc/shared/logs"
}
```

Jangan menyimpan config nyata, community, username SNMPv3, auth password, privacy
password, service-role key, atau token di release maupun Git.

## Environment recurring data plane lokal P10B

Untuk P10E-B, buat direktori persistent `shared/branding` yang dimiliki account
service dengan permission terbatas, lalu tambahkan server-only berikut ke
`shared/backend/.env`:

```dotenv
REPORT_BRANDING_DIR=/var/www/jhc/jhc_noc/shared/branding
```

Direktori ini berada di luar `current`, `releases/`, dan `candidate/`; jangan
menyalin logo ke release SHA. Backend akan membuat `branding.json` dan satu logo
kanonik `report-logo.png` atau `report-logo.jpg`. Hentikan service NetOps sebelum
menyiapkan path/environment, lalu jalankan kembali hanya melalui prosedur release
yang direview. Frontend tidak pernah mengakses filesystem tersebut secara langsung.

Saat rollout P10B direview, isi `/var/www/jhc/jhc_noc/shared/backend/.env` dengan
`HOST=127.0.0.1`, `PORT=3402`, `RUNNER_API_TOKEN`, `SUPABASE_URL`, dan
`SUPABASE_SERVICE_ROLE_KEY`. Isi `/var/www/jhc/jhc_noc/shared/runner/.env` tetap
memerlukan credential Supabase untuk operasi lama, lalu tambahkan:

```text
LOCAL_BACKEND_URL=http://127.0.0.1:3402
LOCAL_BACKEND_TOKEN=<same value as RUNNER_API_TOKEN>
```

Gunakan token acak minimal 32 karakter dan izin file yang hanya dapat dibaca
account service. Jangan menaruh nilai nyata di release, Git, log, atau frontend.
Kedua variabel runner harus dipasang atau dikosongkan bersama. Ketika terpasang,
heartbeat serta recurring Health Watch, Traffic, dan Managed Telemetry memakai
backend loopback. Mengosongkan keduanya saat runner dihentikan mengembalikan
seluruh recurring path tersebut ke Edge Function sebagai rollback. Manual Ping,
Discovery, Device Inspector, dan diagnostics tetap melalui Edge Function.

## Review dan instalasi manual systemd

Sebelum pemasangan, reviewer harus memeriksa path, user/group, Node version,
environment files, ownership, dan isi config. Setelah disetujui, administrator
host dapat menyalin dua template ke `/etc/systemd/system`, menjalankan
`systemctl daemon-reload`, lalu enable/start hanya service berikut:

```text
jhc-netops-runner.service
jhc-netops-frontend.service
```

Tidak ada langkah yang boleh mengubah nginx, PM2, Docker, Cloudflare, database,
atau service project JHC lain. Kedua unit memakai journald. Runner masih boleh
menulis log aplikasinya ke `shared/logs` sesuai config; siapkan rotasi/retensi
terpisah bila log tersebut dipertahankan.

Unit runner memakai satu entrypoint repository:

```text
systemd -> deploy/run-runner.sh -> Node.js runner -> Python agent on demand
```

Launcher memverifikasi Node 22, root release aktif, entrypoint runner, environment,
dan config; memuat environment tanpa mencetak nilainya; lalu mengganti proses Bash
dengan Node melalui `exec`. Ia tidak membuat daemon, PID file, proses background,
atau instance runner kedua.

## Frontend build dan port guard

Release harus memiliki hasil production `.next` sebelum service dimulai. Setelah
`npm ci`, jalankan launcher dari release baru sebelum symlink `current` diubah:

```bash
/usr/bin/bash /var/www/jhc/jhc_noc/releases/<commit>/deploy/build-frontend.sh
```

Launcher menurunkan root source dari lokasinya sendiri, memuat build-time values
dari `shared/frontend/.env`, memastikan `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, dan `NEXT_PUBLIC_SITE_URL` tersedia tanpa
mencetak nilainya, lalu menjalankan production build memakai Node 22. Ia tidak
mengubah symlink atau service. Runtime frontend memakai `deploy/run-frontend.sh`:
launcher memvalidasi `.next`, entrypoint Next.js, Node 22, environment shared,
dan bind port sebelum menjalankan `next start` di foreground melalui `exec`.

Launcher memeriksa bind `192.168.1.130:3401`. Jika endpoint sudah ditempati,
startup gagal dengan `FRONTEND_PORT_IN_USE`. Guard tidak membunuh proses dan tidak
memilih 3402/3403. Periksa konflik secara manual:

```bash
ss -ltnp 'sport = :3401'
systemctl status jhc-netops-frontend.service
journalctl -u jhc-netops-frontend.service -n 100 --no-pager
```

Alamat dan port tersebut adalah deployment setting host staging, bukan business
logic atau asumsi subnet aplikasi.

## Update release

1. Build, test, dan review commit di laptop developer.
2. Buat ZIP dari commit yang sudah direview dengan `git archive`; working tree
   lokal yang belum di-commit tidak boleh ikut.
3. SCP ZIP ke lokasi sementara yang disetujui pada Mini PC.
4. Extract ke `/var/www/jhc/jhc_noc/releases/<commit>` sebagai `mini-pc`.
5. Jalankan `npm ci` untuk frontend, buat ulang venv Python dari lock/manifes,
   dan sinkronkan dependency release. Jangan menyalin `node_modules` atau venv.
6. Jalankan `deploy/build-frontend.sh` dari release baru untuk membuat production
   `.next` memakai environment frontend shared sebelum `current` diubah.
7. Jalankan non-network tests serta runner `--preflight-only` terhadap
   `shared/runner/config.json`. Preflight tidak memberi izin probe aktif.
8. Ubah symlink `current` secara atomik ke release baru yang tervalidasi.
9. Restart hanya `jhc-netops-runner` dan `jhc-netops-frontend`.
10. Verifikasi status unit, journald, heartbeat runner, dan HTTP
    `http://192.168.1.130:3401`.

Jangan mengubah symlink sebelum dependency, build, dan validasi release selesai.

## Rollback

1. Pilih release sebelumnya yang sudah tervalidasi.
2. Ubah symlink `current` secara atomik kembali ke release tersebut.
3. Restart hanya runner dan frontend JHC NetOps.
4. Verifikasi unit, heartbeat, dan UI.

State, logs, config, dan environment tetap berada di `shared`, sehingga rollback
kode tidak menghapus state runtime. Bila kontrak state berubah pada masa depan,
compatibility harus direview sebelum switch.

## P10B Local Backend Rollback (PM2)

Prosedur ini khusus untuk mengganti mode recurring data plane dari backend lokal
(loopback `127.0.0.1:3402`) kembali ke Supabase Edge Function yang ditahan, **tanpa**
mengaruhi release kode atau symlink `current`. Gunakan hanya ketika runner aktif
dan backend lokal dalam mode P10B (`LOCAL_BACKEND_URL` + `LOCAL_BACKEND_TOKEN`
terpasang).

**Nama proses PM2 aktual:**
- `jhc-netops-runner`
- `jhc-netops-backend`
- `jhc-netops-frontend`

**Langkah rollback:**

1. Hentikan hanya NetOps runner:
   ```bash
   pm2 stop jhc-netops-runner
   ```

2. Cadangkan environment runner sebelum diedit:
   ```bash
   cp /var/www/jhc/jhc_noc/shared/runner/.env /var/www/jhc/jhc_noc/shared/runner/.env.p10b-backup
   ```

3. Hapus **KEDUANYA** dari `/var/www/jhc/jhc_noc/shared/runner/.env`:
   ```
   LOCAL_BACKEND_URL
   LOCAL_BACKEND_TOKEN
   ```
   (Biarkan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` tetap ada.)

4. Restart hanya runner:
   ```bash
   pm2 restart jhc-netops-runner
   ```

5. Verifikasi recurring path telah kembali ke Edge:
   - Health Watch: log "Health targets refreshed" tanpa error lokal
   - Traffic: session claim/progress/snapshot/flows via Edge `traffic-live`
   - Managed Telemetry: target list/publish via Edge `managed-telemetry`
   - Heartbeat: tetap lewat lokal (P10A) atau Edge jika `LOCAL_BACKEND_*` kedua kosong

6. Backend lokal boleh tetap jalan (tidak merusak), atau dihentikan opsional:
   ```bash
   pm2 stop jhc-netops-backend
   ```

**LARANGAN:**
- JANGAN gunakan `pm2 restart all`, `pm2 stop all`, `pm2 delete all`, atau `pm2 kill`.
- JANGAN ganti mode lokal/Edge saat operasi recurring (Health Watch probe, Traffic capture, SNMP poll) masih in-flight — P10B sengaja **tidak punya fallback otomatis** dan **tidak dual-write**.
- Operasi normal P10B **wajib** kedua `LOCAL_BACKEND_URL` dan `LOCAL_BACKEND_TOKEN` terpasang; konfigurasi parsial ditolak.

## Batas keamanan

## Batas keamanan

- Service berjalan sebagai `mini-pc`, bukan root, dan launcher tidak memakai
  `sudo`, WSL, Docker, atau PM2. Permission raw-socket Traffic tetap harus
  mengikuti hasil validasi P8A; template tidak menambah privilege.
- `Restart=on-failure` memakai delay lima detik; tidak ada restart loop tanpa
  jeda.
- `KillMode=control-group` menjaga child process release tetap berada dalam
  lifecycle unit.
- Hanya inventory/target yang sudah diotorisasi boleh diaktifkan setelah deploy.
- Instalasi template ini tidak dengan sendirinya mengotorisasi Discovery,
  Device Inspector, Traffic, diagnostics, atau SNMP target baru.

## Process manager masa depan

Gunakan systemd **atau** PM2 untuk NetOps, tidak keduanya. Sebelum memulai PM2,
hentikan kedua unit systemd NetOps agar tidak ada polling/heartbeat ganda atau
konflik port 3401. Default Node 18 server tidak perlu diubah karena launcher
memilih Node 22 secara absolut:

```bash
cd /var/www/jhc/jhc_noc/current
pm2 start deploy/ecosystem.config.cjs
```

Ecosystem tersebut mendefinisikan tepat tiga proses fork, masing-masing satu
instance: `jhc-netops-runner` melalui `deploy/run-runner.sh` dan
`jhc-netops-frontend` melalui `deploy/run-frontend.sh`, serta fondasi P9
`jhc-netops-backend` melalui `deploy/run-backend.sh`. Ketiganya memakai
`/usr/bin/bash`, berjalan dari release `current`, dan dapat direstart oleh PM2.
Konfigurasi tidak menyimpan secret serta tidak mengubah system Node atau default
NVM. Jangan memakai `pm2 start npm`, menjalankan Python sebagai aplikasi PM2
terpisah, atau menjalankan `pm2 save` secara otomatis; instance PM2 tersebut juga
melayani project lain.

## Model akses

- Viewer: visibilitas read-only.
- Operator: operasi jaringan dan konfigurasi target yang sudah dibatasi.
- Admin: seluruh kemampuan Operator ditambah administrasi pengguna/akses.

Status akses terpisah dari role: Menunggu persetujuan, Aktif, atau Ditangguhkan.
Role hanya berlaku bagi akun Aktif.

## Ringkasan runtime

Aplikasi tetap process-manager-neutral. P9 menambahkan backend Node.js mandiri
sebagai proses ketiga di ecosystem PM2; P10B menambahkan route heartbeat,
Network Health, Traffic, dan Managed Telemetry melalui backend lokal. Jika mentor
memilih PM2 di masa depan,
entrypoint runner tetap `deploy/run-runner.sh`; jangan menjalankan service systemd
runner dan proses PM2 runner bersamaan. Frontend tetap proses terpisah. Python
agent bukan service keempat—runner hanya memanggilnya on demand untuk operation
yang memerlukannya. Entrypoint PM2 yang direview adalah
`deploy/ecosystem.config.cjs`; file ini tidak menambah dependency PM2 ke
repository dan tidak menjalankan `pm2 save`.
