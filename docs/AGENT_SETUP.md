# Basic agent & dashboard setup

Tahap ini mengirim metrik agregat interface setiap 10 detik. Agent tidak melakukan
packet capture dan tidak memindai device lain di LAN.

## 1. Terapkan migration Realtime

Jika seluruh migration sebelumnya dikelola dengan Supabase CLI:

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Jika schema awal pernah dijalankan manual melalui SQL Editor, jangan menjalankan
ulang migration awal. Jalankan isi file berikut saja melalui SQL Editor:

```text
supabase/migrations/202608100002_enable_traffic_metrics_realtime.sql
```

## 2. Deploy Edge Function ingest

Dengan project yang sudah terhubung:

```bash
npx supabase functions deploy ingest
```

Function tersedia di:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/ingest
```

Function hanya menerima request dengan service-role key yang sama dengan project.
Status konektivitas dihitung di function, bukan di local agent.

## 3. Siapkan Python agent di WSL

```bash
cd agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
cp .env.example .env
chmod 600 .env
```

Isi minimal `agent/.env`:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Jangan menyalin service-role key ke frontend, repository, screenshot, atau chat.

Variabel opsional:

- `NETWORK_INTERFACE`: nama interface seperti `eth0`; kosong berarti auto-detect.
- `GATEWAY_IP`: target ping gateway; kosong berarti dibaca dari default route.
- `DNS_TEST_HOST`: hostname untuk health check DNS; default `one.one.one.one`.
- `METRICS_INTERVAL_SECONDS`: default `10`.
- `LOCAL_BUFFER_PATH`: default `data/metrics-buffer.sqlite3`.
- `REQUEST_TIMEOUT_SECONDS`: default `10`.
- `LOG_LEVEL`: default `INFO`.

Periksa hasil auto-detection WSL bila perlu:

```bash
ip -4 route show default
ip -brief address
```

Jika command `ip` atau `ping` belum tersedia:

```bash
sudo apt install iproute2 iputils-ping
```

## 4. Jalankan agent

Saat virtual environment aktif:

```bash
network-monitor
```

Alternatif:

```bash
python main.py
```

Metrik pertama muncul setelah satu interval. Tekan `Ctrl+C` untuk berhenti.
Jika Supabase tidak dapat dihubungi, payload tersimpan di SQLite dan dicoba lagi
secara berurutan ketika koneksi pulih.

## 5. Verifikasi

1. Login sebagai user `approved`.
2. Buka `/dashboard`.
3. Pastikan Realtime berubah menjadi `tersambung`.
4. Jalankan agent dan tunggu minimal 10 detik.
5. Pastikan status, throughput, latency, packet loss, gateway, dan DNS tampil.
6. Matikan agent dengan `Ctrl+C`; dashboard mempertahankan metrik terakhir.

## Hermes

Variabel `LLM_API_URL`, `LLM_API_KEY`, dan `LLM_MODEL` belum diperlukan pada tahap
ini. Isi saat Roadmap MVP tahap 4, setelah History/Alerts dan event severity tahap 3
sudah menghasilkan event yang akan dianalisis Hermes.

## 6. Bandwidth & path diagnostics (opsional, tahap 5)

Fitur ini sepenuhnya on-demand dan terpisah dari loop metrik utama. Command
diagnostik tidak memakai `METRICS_INTERVAL_SECONDS` dan tidak boleh dijadwalkan
setiap 10 detik. `iperf3` menghasilkan traffic uji aktif yang dapat memenuhi link.
Jalankan hanya pada jaringan dan target yang sudah memberi izin.

### 6.1 Terapkan schema dan deploy endpoint diagnostik

Dengan project Supabase yang sudah terhubung:

```bash
npx supabase db push
npx supabase functions deploy diagnostics
```

Endpoint diagnostik terpisah tersedia di:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/diagnostics
```

Endpoint ini hanya menulis ke `bandwidth_measurements` dan `hop_measurements`.
Endpoint `ingest`, rolling average, dan klasifikasi severity tidak digunakan.

### 6.2 Install binary di mesin agent WSL

```bash
sudo apt update
sudo apt install iperf3 mtr-tiny
iperf3 --version
mtr --version
```

Agent menjalankan `iperf3` dan `mtr` melalui subprocess dan hanya membaca output
JSON (`-J`/`--json`). Binary tersebut harus tersedia di `PATH` WSL.

### 6.3 Siapkan server iperf3 di titik target

Bandwidth test **tidak akan bekerja tanpa server iperf3 yang sengaja disiapkan**
di titik target. Pada host Linux target yang sudah diizinkan:

```bash
sudo apt update
sudo apt install iperf3
iperf3 -s
```

Default server mendengarkan TCP port `5201`. Izinkan inbound TCP/5201 hanya dari
IP/subnet agent pada firewall target. Untuk port lain, jalankan server dengan
`iperf3 -s -p <port>` dan berikan `--port <port>` pada command agent.

Biarkan terminal server tetap aktif selama test. Opsi daemon tersedia untuk host
yang memang dikelola sebagai server:

```bash
iperf3 -s -D
```

Verifikasi dari WSL agent sebelum test:

```bash
nc -vz <target-ip> 5201
```

Jika target iperf3 berjalan di WSL2 lain dengan mode NAT, koneksi inbound dari LAN
tidak otomatis diteruskan. Gunakan WSL mirrored networking atau konfigurasi
port-forward/firewall Windows secara eksplisit. Ini berbeda dari masalah routing
atau firewall pada jaringan fisik.

### 6.4 Jalankan test manual dari agent

Aktifkan virtual environment agent, lalu jalankan:

```bash
network-monitor bandwidth-test <target-ip> \
  --source-label <nama-lokasi> \
  --target-label <nama-titik-uji> \
  --connection-type wifi

network-monitor path-test <target-ip> \
  --source-label <nama-lokasi> \
  --target-label <nama-titik-uji> \
  --connection-type wifi
```

Hasil default dikirim ke endpoint `diagnostics`. Untuk memeriksa parsing JSON
secara lokal tanpa mengirim ke Supabase:

```bash
network-monitor bandwidth-test <target-ip> --connection-type wifi --no-upload
network-monitor path-test <target-ip> --connection-type wifi --no-upload
```

`--connection-type` wajib diisi dengan `wifi` atau `ethernet`. Nilai ini adalah
deklarasi operator, bukan hasil deteksi otomatis dari interface WSL; `eth0` di WSL
bisa merupakan interface virtual dan tidak membuktikan host memakai Ethernet.
`--source-label` default ke hostname agent dan `--target-label` default ke target,
tetapi sebaiknya isi label lokasi/titik yang konsisten agar perbandingan bermakna.
Hostname/IP yang benar-benar diberikan sebagai `<target-ip>` disimpan terpisah
dari label manusia.

Hasil WiFi mengukur jalur end-to-end client-ke-server dan tidak membuktikan ada
bottleneck pada LAN kabel. Untuk investigasi kabel, switch/uplink, atau segmen LAN,
bandingkan dengan hasil Ethernet dari lokasi yang sama. MTR hanya menampilkan hop
Layer 3 yang merespons; switch Layer 2 dapat tidak terlihat. Dashboard membantu
menentukan *suspected bottleneck*, bukan memastikan perangkat rusak tanpa bukti lain.

### 6.5 Verifikasi pemisahan data

1. Catat jumlah row `events` sebelum test.
2. Jalankan bandwidth test dan path test manual satu kali.
3. Pastikan row baru hanya muncul di `bandwidth_measurements` dan
   `hop_measurements`.
4. Pastikan jumlah row `events` tidak berubah akibat hasil diagnostik.
5. Setelah UI tahap 5 tersedia, pastikan bitrate dan hop muncul di halaman
   diagnostik tanpa mengubah status/severity jaringan normal.

## 7. One-click LAN Diagnostics

Workflow `/diagnostics` memakai Windows Local Diagnostic Runner. Browser hanya
membuat structured job di Supabase; runner yang sudah aktif memanggil agent WSL
secara headless. Runner tidak menerima command atau flags bebas.

Konfigurasi satu kali berada di environment file lokal (default `runner/.env`)
dan `runner/config.local.json`, dibuat dari kedua file `.example`. Field
`environment_file` boleh menunjuk ke environment file lokal lain yang juga
diabaikan Git. Isi
service-role key hanya di file lokal tersebut, jangan commit atau tampilkan di UI.
Konfigurasi memuat distro WSL, project root WSL, executable agent persistent venv,
source location, duration, dan target allow-list. Target localhost diberi
`environment=localhost_demo`; target LAN baru boleh ditambah setelah mendapat izin.
`source location` adalah label lokasi fisik, bukan IP; source IP dan adapter
diambil dari route Windows aktual ke target. Target LAN terotorisasi dapat
ditambahkan dengan validator lokal berikut:

```powershell
python scripts\configure_diagnostic_target.py add --id server-253 --label "Server 253" --ip 192.168.10.253 --port 5201
powershell -ExecutionPolicy Bypass -File runner\task.ps1 restart
```

Validator hanya menerima IPv4 private RFC1918 yang lengkap, membuat backup
config, dan tidak mengubah prinsip bahwa runner me-resolve ulang `target_id`
melalui allow-list lokal.

Invocation runner menggunakan bentuk berikut tanpa shell:

```text
wsl.exe -d Ubuntu-22.04 --exec \
  <wsl-project-root>/agent/.venv/bin/network-monitor \
  diagnostic-run <structured-options>
```

Preflight tidak boleh fallback ke `/usr/bin/python3`. Ia memverifikasi Python venv
project minimal 3.11, executable agent, `/usr/local/bin/iperf3`, `/usr/bin/mtr`,
distro WSL, project root, dan backend config.

Runner memakai Node.js 22 tanpa package runtime tambahan. Verifikasi manual:

```powershell
node .\runner\src\main.mjs --preflight-only
node .\runner\src\main.mjs --once
```

Setup Task Scheduler dijalankan sekali dari PowerShell:

```powershell
.\runner\task.ps1 install
.\runner\task.ps1 status
.\runner\task.ps1 start
.\runner\task.ps1 restart
.\runner\task.ps1 remove
```

Setelah terpasang, runner mulai tersembunyi saat user login. WSL boleh berhenti;
`wsl.exe --exec` akan memulai distro saat job datang. Untuk debugging manual gunakan
runner CLI/README tanpa membuka shell WSL interaktif.
Task tidak memakai execution timeout dan tidak dihentikan saat laptop beralih ke
baterai. Jika card runner menjadi `OFFLINE`, cek `task.ps1 status`, lalu jalankan
`task.ps1 start`; heartbeat berikutnya normalnya muncul dalam 10 detik.

### 7.1 Production target dan Windows network context

Mode normal memakai `enable_diagnostic_demo: false` dan hanya menerbitkan target
`environment: "lan"` yang `enabled`. Localhost tidak menjadi fallback. Tambahkan
target setelah alamat, izin pengujian, firewall, dan iperf3 server dikonfirmasi:

```json
{
  "id": "server-253",
  "label": "Server 253",
  "host": "192.168.1.253",
  "iperf_port": 5201,
  "environment": "lan",
  "enabled": true
}
```

Edit hanya `runner/config.local.json`, validasi JSON, lalu restart Scheduled Task.
Browser hanya menerima ID target yang sudah diterbitkan. Saat eksekusi, runner
selalu resolve ulang ID tersebut ke host/port dari config lokal; host yang ada di
job tidak dipercaya sebagai command target.

Fixed helper `runner/scripts/get-network-context.ps1` menggunakan
`Find-NetRoute` terhadap target allow-listed untuk memilih route Windows aktual.
Helper mengembalikan JSON berisi adapter, tipe koneksi, IPv4/prefix/subnet,
gateway, DNS, local link speed, optional WiFi context, source route, next hop,
metric, ping observations, dan readiness TCP iperf3. Ia dipanggil dengan
argument list dan `shell: false`; browser tidak dapat mengirim script/command.

`connection_type` one-click bukan pilihan operator. Nilai berasal dari adapter
Windows yang digunakan route target. WSL `eth0` tidak digunakan sebagai identitas
WiFi/Ethernet. **Local link speed** adalah negotiated physical/wireless link dan
bukan available bandwidth; throughput end-to-end tetap hasil iperf3.

Preflight ping bersifat observasi. `No ICMP response` tidak membuktikan gateway
atau target offline karena ICMP dapat diblokir. Full bandwidth diagnostic hanya
aktif jika TCP port iperf3 ready. Target on-link tidak memakai default gateway
untuk route itu. MTR hanya memperlihatkan hop Layer-3 yang merespons dan tidak
menampilkan switch/kabel/patch panel Layer-2.

Untuk regression localhost saja, set environment lokal berikut dan restart
runner:

```dotenv
ENABLE_DIAGNOSTIC_DEMO=true
```

Kembalikan ke `false` setelah test. Hasil `localhost_demo` tetap diberi warning
dan dikecualikan dari History LAN normal.

Localhost demo boleh menjalankan server iperf3 sementara yang dimiliki proses test.
Server harus dilacak dan hanya proses yang dibuat runner/agent itu yang dibersihkan.
Jika port sudah dipakai, test gagal aman dan proses existing tidak dibunuh; pilih
port localhost lain di allow-list lokal setelah memastikan port tersebut kosong.
Hasil demo selalu bertuliskan `TEST ENVIRONMENT` dan tidak masuk perbandingan LAN.

## 8. Live Traffic (bounded, this device)

Live Traffic menggunakan runner Windows yang sama, tetapi merupakan operasi terpisah
dari diagnostics dan loop `traffic_metrics`. Tambahkan `traffic_interface` (nama
interface WSL yang sudah diverifikasi secara lokal) dan
`traffic_durations_seconds: [300, 600, 900, 1800]` ke konfigurasi runner. Browser
tidak boleh menentukan interface atau capture filter.

Pada WSL NAT normal, nama tetap seperti `eth0` boleh dipakai. Pada WSL
VirtioProxy/mirrored tertentu nama `enP...` dapat berubah setiap distro start; gunakan
nilai lokal `auto_ipv4`. Mode ini hanya menerima tepat satu NIC IPv4 non-loopback dan
non-link-local, serta gagal aman bila ada lebih dari satu kandidat. Mode ini tidak
menebak apakah koneksi Windows adalah WiFi atau Ethernet.

Scapy membutuhkan raw socket, sehingga hanya child command `traffic-live` yang
dijalankan runner sebagai user `root` melalui argumen terstruktur `wsl.exe --exec`.
Runner sendiri tetap berjalan sebagai Windows user biasa. Capture menyimpan header
metadata IPv4 TCP/UDP/ICMP saja; payload/PCAP/content tidak disimpan.

Setelah migration dan Edge Function `traffic-live` dideploy, restart Scheduled Task
agar capability baru terkirim pada heartbeat:

```powershell
Stop-ScheduledTask -TaskName "Network Monitoring Local Runner"
.\runner\task.ps1 start
.\runner\task.ps1 status
```

Verifikasi interface sebelum capture kecil pertama:

```powershell
wsl.exe -d Ubuntu-22.04 --exec /usr/sbin/ip -brief address
```

Default cadence adalah snapshot 2 detik dan upsert flow 10 detik. Flow persisted
ditahan 48 jam; snapshot stale dibersihkan setelah 2 jam; session terminal setelah
7 hari. Pada ukuran tabel flow di atas 300 MB batch diperkecil, dan pada 400 MB
capture baru serta persistence dibatasi sampai cleanup/storage ditangani.

## 9. Lightweight Network Health Watch

Health Watch berjalan di Windows runner/Task Scheduler yang sama, tetapi scheduler-nya
independen dari Traffic capture, LAN Diagnostics, dan `traffic_metrics`. Terapkan
migration `202608140003_network_health_watch.sql`, deploy function, lalu restart runner:

```powershell
npx supabase db push
npx supabase functions deploy network-health
.\runner\task.ps1 restart
```

Admin membuka `/admin#network-health-targets`, memilih node yang sudah ada di
`network_nodes`, memilih runner, lalu mengatur enabled/critical dan threshold.
Tidak ada target yang dibuat atau diaktifkan otomatis; perangkat di luar inventory
tidak diprobe. Metode MVP hanya ICMP dan tidak membutuhkan agent WSL/Scapy/SNMP.
SNMP read-only telemetry adalah workflow terpisah (bagian 12), bukan bagian dari Health Watch.

Default normal adalah interval 30 detik, timeout 1 detik, 3 failure untuk offline,
dan 2 success untuk recovery. Target critical dapat memakai 15 detik. Runner memakai
concurrency maksimal 4, menyimpan window maksimal 5 sample dan transition queue
bounded di `runner/data/network-health-state.json`, lalu batch publish maksimal sekali
per 60 detik kecuali ada transisi. Kegagalan backend memakai exponential backoff
hingga 60 detik; latest state dikoalesi dan tidak membuat backlog satu row per ping.

Status `offline` berarti tidak ada respons ICMP setelah threshold. Ini tidak
membuktikan perangkat mati karena ICMP dapat diblokir/rate-limited atau jalur dapat
bermasalah. Gunakan link LAN Diagnostics untuk pengujian on-demand yang sudah
diotorisasi; membuka link tidak otomatis menghasilkan traffic iperf3/MTR.

## 10. On-demand Network Discovery

Terapkan migration dan deploy function, lalu restart runner agar capability
`network_discovery` diterbitkan:

```powershell
npx supabase db push
npx supabase functions deploy network-discovery
.\runner\task.ps1 restart
```

Admin membuka Dashboard, memilih `Discover Network`, menunggu context Windows
terdeteksi, lalu menekan `Start Discovery`. Tidak ada CIDR/range/flag yang perlu atau
boleh diisi. Fixed helper memilih default physical IPv4 route Windows. Prefix yang lebih
lebar dari `/24` ditolak; `/24`–`/30` dipindai sekali dengan concurrency 4 dan timeout
400 ms memakai Windows neighbor cache + ICMP. Tidak ada port/service/OS scan.

Hasil hanya berada pada satu temporary row per runner, dioverwrite selama progres, dan
host/context dibersihkan setelah 10 menit oleh polling runner/Edge cleanup. `Beri nama`
hanya menyimpan identity `network_nodes`; admin tetap harus menekan `Add to Health Watch`
untuk membuat atau enable `network_targets`. Discovery tidak memulai Traffic capture,
iperf3/MTR, SNMP, atau sweep berkala. SNMP read-only hanya untuk target terkelola
allow-listed pada bagian 12.

## 11. Quick Device Inspector

Terapkan migration dan deploy endpoint, lalu restart runner agar capability `device_inspect` diterbitkan:

```powershell
npx supabase db push
npx supabase functions deploy device-inspector
.\runner\task.ps1 restart
```

Preflight runner menjalankan capability check satu kali saat startup melalui project
virtualenv. Gunakan command berikut untuk audit manual dari jalur WSL yang sama:

```powershell
wsl.exe -d Ubuntu-22.04 --exec `
  /mnt/c/Users/rakas/OneDrive/Documents/JHC-work/Network-Monitoring/agent/.venv/bin/network-monitor `
  capabilities

node.exe runner\src\main.mjs --preflight-only
```

Output capability harus menyatakan `probe_engine: "python_socket"` dan
`required.python_socket: true`. `openssl` serta database OUI Scapy bersifat opsional;
ketidaktersediaannya menghasilkan fingerprint parsial. `nmap` dan `curl` diaudit agar
status runtime terlihat, tetapi collector Device Inspector saat ini tidak memanggil
keduanya. `arp-scan`, `nbtscan`, dan mDNS juga tidak wajib. Browser tidak memasang tool
atau Python dependency secara otomatis.

Untuk memeriksa context Windows satu target inventory secara read-only:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File runner\scripts\get-device-inspection-context.ps1 `
  -TargetIp 192.168.188.249
```

Helper memilih object `MSFT_NetIPAddress` dan `MSFT_NetRoute` secara eksplisit dari
`Find-NetRoute`. Jangan membaca `InterfaceIndex` langsung dari array gabungan kedua
object tersebut. Output juga membawa `is_this_device`, `interface_alias`,
`interface_description`, `interface_index`, dan `interface_type`. `is_this_device`
harus berasal dari kecocokan target dengan alamat host Windows; klasifikasi virtual
berasal dari metadata adapter (`HardwareInterface`, vEthernet/Hyper-V/WSL/VM adapter),
bukan subnet atau nama `eth0` WSL.

Inspection hanya dapat dimulai admin untuk satu IP pada hasil Discovery yang belum expired atau inventory `network_nodes`. Target inventory tetap valid tanpa sesi Discovery aktif. Tidak ada input command, CIDR, URI, port, atau scanner flags di UI. Agent memakai TCP 22/80/443/445/554/631/1883/8080/8443/9100, SSDP unicast UDP/1900, dan NetBIOS Node Status UDP/137 hanya ketika SMB/445 terbuka. Concurrency seluruh probe optional maksimal 4, timeout per koneksi 1 detik, metadata HTTP maksimal 16 KiB, XML UPnP maksimal 32 KiB, dan hard timeout runner 30 detik. Nmap tidak wajib dan tidak digunakan collector saat ini.

MAC/OUI hanya diambil dari Windows neighbor untuk target same-subnet. Target routed tidak mendapat MAC dari next-hop. Lookup OUI memakai database lokal Scapy; locally administered MAC dianggap tidak reliable. HTTP/HTTPS hanya mengambil status/header/title kecil tanpa mengikuti redirect. TLS menyimpan CN/SAN/issuer/masa berlaku normalized. URL UPnP harus `http`, tanpa credential, resolve kembali ke IP target, dan redirect deskripsi ditolak. NetBIOS hanya meminta satu Node Status untuk hostname—tanpa share/user/file/auth. mDNS dilewati; SNMP, LLDP, full-port/deep/vulnerability scan tetap di luar scope
Device Inspector. SNMP read-only telemetry adalah workflow terpisah (bagian 12).

## 12. Managed Infrastructure Telemetry (SNMP read-only)

Migration `202608160001_managed_infrastructure_telemetry.sql` menambahkan
`managed_telemetry_targets`, `managed_device_latest`, dan `managed_interface_latest`
beserta RLS, index, dan keanggotaan Realtime. **Status saat ini: migration sudah
diterapkan manual oleh Raka ke project Supabase dan terverifikasi remote — schema
tabel ada, RLS approved-read untuk admin/viewer fixture (HTTP 200), dan Realtime
latest-state terverifikasi lewat browser E2E tanpa refresh.** Setelah migration
diterapkan, restart runner agar capability `snmp_telemetry` diterbitkan:

```powershell
.\runner\task.ps1 restart
```

Edge Function `managed-telemetry` sudah diimplementasikan dan lolos contract/unit
test, tetapi **belum di-deploy** — runtime/deployment verification ditunda dan bukan
bagian dari setup ini.

Admin membuka `/admin#managed-telemetry`, memilih node yang sudah ada di
`network_nodes`, memilih runner, versi SNMP, dan **credential profile lokal runner**
(`monitoring-readonly` / `core-readonly`). Form hanya menyimpan nama profile—bukan
community string, username, atau password. Profile didefinisikan di config lokal
runner; sekret tidak pernah dikirim ke Supabase, browser, atau log. Profile yang tidak
tersedia ditandai `available = false` dan tidak dipoll.

Runner melakukan polling read-only SNMPv2c/v3 dengan OID tetap dan terbatas (identitas
sistem, uptime, satu set interface fisik/logis, octet counters, error/discard).
Interval default 60 detik (boleh 30–300), concurrency kecil, timeout pendek, dan tidak
mengganggu capture/Health Watch/Discovery/Diagnostics. Counter cache lokal dipakai
menghitung rate/utilisasi antar-poll; hanya latest-state yang di-upsert (satu
`managed_device_latest` + satu `managed_interface_latest` per interface) dan event
`source = managed_telemetry` dibuat hanya saat transisi threshold
(errors/discards/up/down/util). Tidak ada walk bebas, SNMP SET, LLDP/CDP, topology,
atau row per poll.

UI: Device Profile menampilkan bagian Managed Infrastructure Telemetry (status koneksi
target, identitas sistem, uptime, tabel interface + peringatan) dengan satu subscription
Realtime sehingga state berubah tanpa refresh; status credential profile ditampilkan
tanpa pernah menampilkan nilai secret. Approved viewer read-only; admin CRUD target.
Verifikasi sintetis memakai `scripts/verify_managed_telemetry_browser.mjs` (fixtures
synthetic, admin/viewer, Realtime, mobile/desktop, tanpa probe SNMP nyata).

Hasil sementara berada di satu `device_inspection_sessions` row per runner dan expired 10 menit. Menutup drawer unknown tanpa Save tidak membuat `network_nodes`. `Save identity` menyimpan operator name/location/type/notes secara eksplisit; `Save detected evidence` menyimpan fingerprint terstruktur. Reinspection hanya boleh memperbarui `detected_fingerprint` dan `last_inspected_at` tanpa mengubah identity atau Health Watch. Bila evidence `This Device` bertentangan dengan kategori operator, perbaiki inventory secara eksplisit melalui form—warning tidak melakukan overwrite otomatis. Jangan menulis raw tool stdout, HTML/XML/body, token, atau credential ke Supabase/log.
