# PRD — Network Traffic Monitoring Dashboard

## 1. Latar belakang & tujuan

Project ini dibuat untuk membantu Raka saat bertugas sebagai IT Support (kantor/kampus) memantau kondisi jaringan secara real-time: apakah jaringan berjalan normal, sedang high traffic, mengalami penurunan traffic, atau bahkan tidak ada koneksi internet sama sekali (not internet). Selain sebagai alat kerja, project ini juga berfungsi sebagai portofolio menuju arah karier network/architecture engineering.

## 2. Problem statement

Saat ini deteksi masalah jaringan dilakukan secara manual/reaktif (menunggu laporan pengguna). Tidak ada visibilitas historis untuk event yang pernah terjadi, tidak ada klasifikasi urgensi, dan tidak ada cara cepat untuk melihat detail traffic saat troubleshooting.

## 3. Target pengguna

- **Admin (Raka)** — akses penuh, approve user baru, lihat semua data.
- **Viewer (approved user)** — bisa memantau dashboard, traffic, history, dan alert. Tidak bisa approve user lain.
- **User baru (pending)** — sudah register tapi menunggu approval, belum bisa akses data.

## 4. Goals

1. Deteksi status jaringan otomatis: `normal`, `high_traffic`, `low_traffic`, `down`, `not_internet`.
2. Tampilkan detail traffic mirip Wireshark (ringkas, flow-based, bukan raw packet) dengan search & filter.
3. Simpan history event penting dengan klasifikasi severity: `low`, `medium`, `high`, `critical`.
4. Alert real-time untuk event yang sedang aktif.
5. AI agent (Hermes) membaca history sebagai knowledge untuk memberi ringkasan/analisis otomatis pada event.
6. Autentikasi dengan alur register → approval manual oleh admin.
7. Bisa dijalankan portable di laptop pribadi, dan bisa diakses dari browser mana saja setelah dideploy.
8. Seluruh infrastruktur hosting menggunakan free tier.
9. Diagnostik bandwidth & path on-demand: ukur throughput real (bukan cuma ping) dan hop latency antar titik, untuk memvalidasi dugaan bottleneck topologi (mis. cek apakah masalahnya di jalur/hop tertentu, bukan cuma "internet lambat").

## 5. Non-goals (di luar scope MVP)

- Menyimpan raw packet capture (pcap) secara penuh di database.
- Machine learning custom untuk deteksi anomali (versi awal pakai rule-based threshold).
- Multi-lokasi/multi-agent secara bersamaan (bisa jadi pengembangan lanjutan).
- Mobile app native.
- Bandwidth/path diagnostics berjalan kontinu real-time seperti `traffic_metrics` — ini fitur on-demand/interval panjang, sengaja dipisah supaya tidak memicu false alarm di severity engine (lihat bagian 7.5).

## 6. Arsitektur sistem

```
[Local capture agent (Python, laptop)]
        | push metrics & flow (REST, tiap 10 detik)
        | push bandwidth & hop measurement (REST, on-demand/interval panjang)
        v
[Supabase: Auth + Postgres + Realtime]
   |                              |
   | realtime subscribe           | baca history / tulis analisa
   v                              v
[Next.js dashboard (Vercel)]   [Hermes AI Agent (Flask, HF Space)]
```

Catatan penting: proses capture paket **harus** berjalan di device yang terhubung langsung ke jaringan target (laptop Raka), tidak bisa dilakukan dari backend cloud/serverless.

Catatan tambahan: pengukuran bandwidth (`iperf3`) butuh `iperf3 -s` jalan di titik target (mis. server pusat) sebagai counterpart. Ini di luar jalur `traffic_metrics`/severity — datanya masuk tabel terpisah (`bandwidth_measurements`, `hop_measurements`) dan tidak dihitung ke baseline rolling average, supaya test bandwidth yang sengaja generate traffic tinggi tidak memicu event `medium`/`high` palsu.

## 7. Komponen

### 7.1 Local capture agent (Python)
- Library: `scapy` atau `pyshark` (capture & parsing paket), `psutil` (statistik interface), `requests`/`supabase-py` (push data).
- Fungsi:
  - Hitung metrik agregat per interval (default 10 detik): bytes in/out, packet count, breakdown protokol.
  - Health check: ping ke gateway, resolve DNS → indikator `gateway_reachable`, `dns_reachable`.
  - Kumpulkan flow ringkas (5-tuple: src/dst IP, port, protocol, size, timestamp) — bukan raw packet.
  - Buffer lokal (SQLite/file) saat koneksi ke Supabase terputus, retry otomatis.

### 7.2 Backend — Supabase
- Auth bawaan Supabase + tabel `profiles` untuk role & status approval.
- Edge function `ingest`: terima data dari agent, bandingkan ke baseline, hitung status, simpan ke `traffic_metrics`, buat row `events` jika melewati threshold.
- RLS: hanya `status = approved` yang bisa membaca data operasional.
- Realtime channel: push update ke frontend tanpa polling.

### 7.3 Frontend — Next.js (Vercel)
Halaman:
- **Dashboard** — status ringkas saat ini + grafik traffic singkat.
- **Traffic** — tabel flow detail dengan search & filter dropdown (protocol, IP, port, rentang waktu).
- **History** — daftar event yang sudah terjadi, difilter berdasarkan severity/tanggal.
- **Alert** — event yang sedang aktif (belum `resolved_at`).
- **Admin (khusus role admin)** — daftar user `pending`, tombol approve/reject.

### 7.4 Hermes AI Agent (Flask, Hugging Face Spaces)
- Dipanggil event-based (bukan polling terus-menerus), saat ada event baru dengan severity signifikan.
- Endpoint `/analyze`: ambil context history (jsonb) dari Supabase terkait event serupa, kirim ke LLM, tulis `ai_summary` kembali ke tabel `events`.

### 7.5 Bandwidth & path diagnostics (on-demand)
- Bagian dari local capture agent, tapi job terpisah dari agregasi traffic 10 detik — dijalankan manual (`network-monitor bandwidth-test`) atau terjadwal jarang (default tiap 5-15 menit, jangan sekencang metrik biasa).
- **Throughput**: `iperf3 -c <target> -J`, target adalah `iperf3 -s` yang jalan di titik yang mau diuji (mis. server pusat). Hasil: `bitrate_mbps`, `jitter_ms`.
- **Hop path**: `mtr --json -c 5 <target>`. Hasil: daftar hop dengan `avg_latency_ms` dan `loss_percent` per hop — dipakai buat lihat di hop mana delay mulai muncul (mis. validasi dugaan router selasar jadi bottleneck).
- Setiap command wajib menerima `connection_type` eksplisit (`wifi`/`ethernet`); jangan infer dari nama interface WSL seperti `eth0`. Simpan juga label lokasi sumber, label target, dan hostname/IP target asli agar hasil bisa dibandingkan dan ditelusuri.
- WiFi dan Ethernet tetap memakai pipeline, endpoint, dan tabel yang sama. WiFi adalah pengukuran end-to-end client-ke-server, tetapi bukan bukti bottleneck LAN kabel. Untuk dugaan kabel, switch/uplink, atau segmen LAN, prioritaskan hasil Ethernet.
- Kedua hasil dikirim lewat endpoint terpisah (bukan `ingest` yang sama dengan `traffic_metrics`), disimpan ke tabel `bandwidth_measurements` dan `hop_measurements` (lihat bagian 8).
- **Tidak** masuk ke perhitungan baseline/severity di bagian 9 — ini data diagnostik yang dilihat manual di dashboard, bukan trigger otomatis.
- Dashboard menyediakan filter sumber, target, dan tipe koneksi, serta perbandingan numerik latest bitrate untuk beberapa lokasi menuju target yang sama. Interpretasi hanya menunjukkan *suspected bottleneck*: MTR menampilkan hop Layer 3 yang merespons dan tidak menampilkan setiap switch Layer 2.
- IP hop yang merespons dapat diberi label manual melalui lookup reusable
  `network_nodes`. Label, tipe perangkat, lokasi, dan notes tidak disalin ke
  `hop_measurements`; UI me-resolve metadata terkini berdasarkan `hop_ip`, sehingga
  rename/delete berlaku juga untuk history tanpa mengubah measurement faktual.
  Unknown IP tetap ditampilkan sebagai **Unknown node** sampai admin memberi nama.
  Label inventory tidak membuktikan paket melewati perangkat Layer-2 yang tidak
  muncul sebagai responding hop MTR.
- Workflow utama tersedia di halaman `/diagnostics`. Browser membuat job terstruktur di Supabase; Windows Local Diagnostic Runner yang sudah aktif menerima job, memanggil executable project `agent/.venv/bin/network-monitor` melalui `wsl.exe --exec`, lalu mengirim progress ke Supabase Realtime. Browser/Vercel tidak pernah menjalankan command lokal secara langsung.
- Full diagnostic menjalankan upload (`client -> server`), download dengan reverse mode (`server -> client`), lalu MTR. Setiap arah bandwidth disimpan sebagai row terpisah; `bitrate_mbps` tetap berarti final/average receiver throughput untuk arah tersebut.
- Live interval hanya disimpan sementara pada `diagnostic_jobs.progress` dan dibatasi selama job aktif. Setelah selesai, sample live dibersihkan; hasil final tetap berada di tabel measurement.
- Localhost development memakai environment `localhost_demo`, diberi label **TEST ENVIRONMENT**, dan tidak boleh dipakai sebagai bukti performa WiFi/Ethernet atau bottleneck LAN.
- Workflow normal mengambil snapshot konteks jaringan dari host Windows, bukan dari
  interface virtual WSL. Fixed runner helper melakukan route lookup ke target
  allow-listed untuk menentukan adapter aktual, source IP, connection type,
  next hop, dan on-link/routed. Operator hanya memilih/menulis label lokasi,
  memilih target resmi, dan memilih durasi 5/10 detik.
- Sebelum iperf3, runner menjalankan preflight bounded: route, optional ping
  next-hop, ping target dengan semantik `no ICMP response`, dan TCP readiness
  pada port iperf3. ICMP failure sendiri tidak membuktikan perangkat offline.
- Link speed Windows selalu disebut **Local link speed** dan tidak sama dengan
  available bandwidth, observed Traffic, atau measured iperf throughput.
- Mode normal menyembunyikan target localhost dan `Local Development`.
  `ENABLE_DIAGNOSTIC_DEMO=true` mengaktifkannya secara eksplisit untuk regression
  test, dengan warning bahwa hasil bukan bukti LAN.

### 7.6 Windows Local Diagnostic Runner
- Runner kecil berjalan di Windows dan dapat dipasang auto-start melalui Task Scheduler saat user login.
- Runner mengirim heartbeat, mengambil job queued, memvalidasi operation/source/target/duration/connection terhadap allow-list lokal, lalu menjalankan WSL tanpa terminal interaktif.
- Runner hanya menjadi orchestration bridge. Eksekusi serta parsing `iperf3`/`mtr`, normalisasi measurement, dan diagnostic semantics tetap berada di agent WSL.
- Invocation memakai argument list dengan `shell=False`, `CREATE_NO_WINDOW`, dan `wsl.exe -d <distro> --exec <agent-venv-executable> diagnostic-run ...`. Tidak menerima command atau flags bebas dari browser/database.
- `target_id` selalu di-resolve ulang melalui konfigurasi lokal runner. Snapshot `target_host` di job hanya untuk audit/display dan tidak dipercaya sebagai target eksekusi.
- Runner dianggap offline jika heartbeat melewati batas freshness. Preflight menerbitkan safe code seperti `AGENT_VENV_MISSING`, `AGENT_PYTHON_UNSUPPORTED`, `IPERF3_MISSING`, `MTR_MISSING`, atau `WSL_DISTRO_NOT_FOUND` tanpa membocorkan stack trace ke UI.

### 7.7 Live Traffic / Flow Explorer
- Traffic adalah bounded on-demand session untuk metadata traffic yang terlihat oleh interface monitoring host. Capture scope MVP selalu **This Device**; tidak mengklaim seluruh traffic rumah sakit terlihat.
- Admin boleh start/stop session 5/10/15/30 menit; approved viewer read-only. Runner yang sama memanggil structured command `traffic-live`, tanpa shell/filter bebas. Agent dan backend tetap menegakkan hard maximum 30 menit.
- Stop untuk session yang masih queued langsung mengakhiri session tanpa masuk
  state `stopping`. Snapshot live memperbarui lease session aktif. Jika runner
  restart/crash dan lease berhenti diperbarui, heartbeat runner, claim, serta API
  user merekonsiliasi lock yatim ke `expired`; capture dengan lease segar tetap
  mengunci runner agar tidak berjalan bersamaan dengan bandwidth diagnostics.
- Scapy hanya mengekstrak directional 5-tuple, timestamps, byte, dan packet count. Payload, PCAP, URL, DNS content, hostname, credential, cookie, token, serta data aplikasi/pasien tidak dikumpulkan.
- Packet diagregasi lokal dalam map 5-tuple. Live snapshot 2 detik berisi maksimal 100 flow, 30 conversation, dan 10 top talker dengan payload maksimal 64 KiB; satu row snapshot per runner dioverwrite dan satu Realtime subscription dipakai per halaman.
- Flow persistence memakai cumulative upsert batch maksimal 100 changed flow setiap 10 detik, bukan packet-per-row. ACTIVE berarti terlihat dalam 5 detik, recently idle sampai 15 detik, lalu flow keluar dari live snapshot pada 30 detik.
- Flow dan conversation berbeda: flow mempertahankan arah A→B; conversation menormalisasi pasangan endpoint tetapi tetap menyimpan byte A→B dan B→A.
- Fine-grained flow disimpan 48 jam dan dibersihkan hourly dalam batch 5.000. Snapshot stale dibersihkan setelah 2 jam dan terminal session setelah 7 hari. Pada ukuran `flows` >300 MB backend memberi warning; >400 MB optional flow history dihentikan agar events dan diagnostic result tetap diprioritaskan.
- Observed traffic/rate tidak sama dengan available bandwidth. Flow Detail hanya boleh menautkan **latest measured path** terpisah; jangan mengklaim hop MTR sebagai exact route flow.
- SPAN, NetFlow, dan broad infrastructure collector tetap future scope. Managed Infrastructure Telemetry (SNMP read-only untuk target allow-listed) diimplementasikan sebagai workflow terpisah pada bagian 7.11.

### 7.8 Lightweight Network Health Watch

- Dashboard menjadi pemilik status reachability kontinu untuk target inventory yang dikenal: `online`, `degraded`, atau `offline`.
- Target dipilih eksplisit dari `network_nodes` dan ditugaskan ke Windows runner yang sudah ada. Health Watch sendiri tidak melakukan subnet scan/discovery, SNMP, credential perangkat, atau topology inference. SNMP read-only telemetry adalah workflow terpisah pada bagian 7.11, bukan bagian dari Health Watch. Hasil discovery on-demand pada bagian 7.9 hanya menjadi target setelah promosi admin eksplisit.
- Runner menjalankan ICMP probe bounded secara asynchronous dengan concurrency terbatas. Default interval 30 detik; target critical boleh 15 detik. Tiga kegagalan beruntun diperlukan untuk `offline`, dan dua keberhasilan beruntun untuk recovery; threshold dapat dikonfigurasi admin dalam batas aman.
- ICMP failure tidak membuktikan perangkat mati. Firewall/rate-limit/path failure dapat mencegah respons; UI dan event wajib memakai bahasa hati-hati.
- Sampel disimpan sebagai short window lokal maksimal lima hasil. Backend hanya menyimpan satu latest row per target dan event saat status berubah; tidak membuat row per ping.
- Health scheduler, Edge Function `network-health`, dan event `source = network_health` terpisah dari `traffic_metrics`, baseline/severity ingest, Traffic capture, serta bandwidth/path diagnostics on-demand.
- Dashboard memakai satu channel Realtime untuk latest health dan event changes. Link ke LAN Diagnostics hanya prefill target dan tidak menjalankan tes otomatis.

### 7.9 On-demand Network Discovery

- Discovery menjawab host IPv4 mana yang terlihat pada subnet lokal Windows saat ini;
  bukan traffic analysis, health monitoring, LAN throughput, atau topology mapping.
- Admin memulai discovery dari drawer Dashboard. Browser hanya mengirim runner ID dan
  structured action; subnet/CIDR/range/flag tidak diterima. Runner menentukan default
  physical route Windows dan hanya mengizinkan prefix `/24` sampai `/30`.
- Metode MVP menggabungkan Windows neighbor cache dengan satu ICMP bounded per usable
  address, concurrency 4 dan timeout 400 ms. Tidak ada port/service scan, OS fingerprint,
  vulnerability scan, SNMP, payload, atau sweep berulang. SNMP read-only telemetry (7.11)
  hanya memakai target yang sudah ada di `network_nodes` dan tidak berbagi engine/mekanisme Discovery.
- Hasil progresif disimpan dalam satu temporary slot per runner, dioverwrite maksimal
  setiap 32 alamat, bounded 254 host/64 KiB, dan dibersihkan 10 menit setelah selesai.
  Tidak ada row per ping dan tidak ada history discovery permanen.
- State `DISCOVERED`, `KNOWN`, dan `MONITORED` tetap berbeda. `Beri nama` memakai
  `network_nodes`; `Add to Health Watch` membuat/mengaktifkan `network_targets` hanya
  setelah admin memilih secara eksplisit. Traffic correlation hanya lookup IP dari live
  snapshot dan tidak menyalin flow.

### 7.10 Quick Device Inspector dan Device Profile

- Device Inspector menjawab identitas yang mungkin dari **satu** IP yang dipilih admin berdasarkan evidence terstruktur. Fitur ini tidak menggantikan Discovery, Health Watch, Traffic, atau LAN Diagnostics dan tidak membuat halaman baru.
- Active inspection hanya boleh dimulai lewat klik admin untuk IP yang masih berada di hasil Discovery aktif atau sudah ada di `network_nodes`. Browser hanya mengirim `runner_id` dan `target_ip`; command, CIDR, URI, port list, flag, NSE, dan script bebas selalu ditolak dan target divalidasi ulang oleh runner.
- Quick Inspect memakai probe tetap dan bounded: TCP 22/80/443/445/554/631/1883/8080/8443/9100, SSDP unicast UDP/1900, dan optional NetBIOS Node Status UDP/137 hanya setelah SMB/445 terbuka. Concurrency maksimal 4, timeout pendek, metadata HTTP maksimal 16 KiB, XML UPnP maksimal 32 KiB, dan total operasi maksimal 30 detik. Tidak ada full-port scan, vulnerability scan, credential attempt, crawling, redirect follow, atau inspeksi rekursif/background.
- Evidence normalized dapat mencakup route role, MAC/OUI lokal, metadata adapter Windows, state port fixed allow-list, header/title HTTP, CN/SAN/issuer/validity TLS, identity UPnP same-target, dan optional hostname NetBIOS. Jika target sama dengan alamat IPv4 host Windows, role otomatis adalah `This Device`; alias, deskripsi, `InterfaceIndex`, dan status physical/virtual disimpan sebagai evidence tanpa menebak dari range IP. Raw stdout, HTML/XML/body, cookie, token, credential, dan payload aplikasi tidak dikirim ke Supabase. Timeout tetap dilabeli `timeout`, bukan ditebak sebagai filtered.
- MAC target hanya boleh digunakan pada subnet Layer-2 yang sama. Untuk target routed, MAC target harus `null`; jangan memakai MAC next-hop/gateway sebagai MAC target. Locally administered/randomized MAC tidak diberi vendor dan tidak menambah confidence.
- Classification menggabungkan beberapa evidence dan menghasilkan manufacturer, model, likely device type, capabilities, confidence (`high`/`medium`/`low`/`unknown`), serta alasan. MAC vendor adalah vendor NIC, bukan otomatis manufacturer perangkat.
- Hasil parsial yang berhasil tetapi tidak memiliki evidence identitas cukup ditampilkan sebagai `Insufficient evidence`, bukan error. Device type dan capabilities tetap terpisah; managed switch hanya boleh diklasifikasikan dari identity eksplisit yang kuat.
- Detected identity (`detected_fingerprint`, `last_inspected_at`) terpisah dari operator identity (`name`, `location`, `device_type`, `notes`). Reinspection tidak boleh menimpa operator identity atau status Health Watch dan tidak membuat event alert.
- Hasil inspection pertama bersifat temporary dalam satu slot per runner dan expired setelah 10 menit. Unknown device tidak otomatis dibuat sebagai inventory. Penyimpanan fingerprint/operator identity memerlukan action admin eksplisit; approved viewer hanya dapat melihat profile yang sudah disimpan. Konflik antara role otomatis `This Device` dan kategori operator hanya menghasilkan peringatan inventory-quality; sistem tidak mengubah nama/kategori operator, membuat Health target, atau membuat alert secara otomatis.
- Satu reusable Device Profile drawer dipakai dari Discovery, Health Watch, Traffic, dan hop LAN Diagnostics. Unmanaged Layer-2 switch tanpa IP management mungkin tidak terlihat, MTR hanya menampilkan responding Layer-3 hops, dan hasil adalah evidence identitas—bukan topology discovery atau bukti perangkat rusak.
- SNMP read-only untuk target terkelola (allow-list) diimplementasikan pada bagian 7.11; LLDP/CDP, topology mapping, SNMP SET, deep scan, SPAN/NetFlow, dan vulnerability assessment tetap di luar scope iterasi ini.

### 7.11 Managed Infrastructure Telemetry (SNMP read-only)

- Fitur ini menjawab "berapa throughput/utilisasi/error/discard port perangkat terkelola yang disetujui" dari perangkat itu sendiri (SNMP read-only), terpisah dari Traffic pasif pada bagian 7.1–7.7, Health Watch (7.8), Discovery (7.9), dan Device Inspector (7.10).
- Hanya perangkat yang sudah ada di `network_nodes` yang boleh dijadikan target. Admin menambahkan satu target melalui `/admin#managed-telemetry` dan memilih **credential profile** yang sudah didefinisikan (bukan memasukkan community string atau username/password SNMP di form). Nama profile dapat merujuk ke `monitoring-readonly` atau `core-readonly`; sekretnya hanya ada di config lokal runner dan tidak pernah dikirim ke Supabase, browser, atau log.
- Runner memakai profil lokal untuk melakukan polling SNMPv2c/v3 read-only dengan OID tetap dan terbatas (identitas sistem, uptime, satu set interface fisik/logis, oktet counters, dan error/discard). Tidak ada walk bebas, kredensial tebakan, SNMP SET, LLDP/CDP, topology discovery, atau deep scan.
- Polling bounded: interval default 60 detik (boleh 30–300 sesuai target), concurrency kecil, timeout pendek, dan tidak mengganggu capture/Health Watch/Diagnostics. Runner hanya menyimpan **latest-state** (satu row device + satu row per interface) plus event transisi saat nilai ambang terlewati; tidak membuat row per poll.
- Credential profile dapat berlabel `available`/`missing` pada runner. UI hanya menampilkan status ketersediaan; profile yang tidak tersedia tidak mencoba polling dan diberi label di UI.
- UI: bagian Device Profile menampilkan status koneksi target, identitas sistem, uptime, daftar interface dengan utilisasi/history arah/error/discard, dan peringatan per interface (up/down, link flap, speed change, utilisasi tinggi). Drawer tetap realtime (state berubah tanpa refresh). Admin dapat menambah/mengubah/menonaktifkan target; approved viewer read-only.
- Nilai ambang (`errors`/`discards`/`up_percent`/`down_percent`/`util_percent`) bersifat tetap dan terpusat di frontend helper, bukan per-target. Bahasa UI hati-hati: throughput/error/discard SNMP tidak membuktikan perangkat rusak.
- Browser hanya melakukan `select` pada tabel telemetry; penulisan state latest hanya lewat service-role runner endpoint dan config lewat action admin dengan RLS.

## 8. Skema data (ringkas)

**profiles**: id (PK, uuid), email, full_name, role (`admin`/`viewer`), status (`pending`/`approved`/`rejected`), created_at, approved_at, approved_by (FK -> profiles.id)

**traffic_metrics**: id (PK), recorded_at, interval_seconds, bytes_in, bytes_out, packet_count, avg_latency_ms, packet_loss_pct, gateway_reachable, dns_reachable, protocol_breakdown (jsonb), status

**flows**: id (PK), first_seen, last_seen, src_ip (inet), dst_ip (inet), src_port, dst_port, protocol, total_bytes, packet_count

**events**: id (PK), created_at, severity (`low`/`medium`/`high`/`critical`), title, description, raw_context (jsonb), ai_summary, resolved_at (nullable), source (typed origin; `network_health` terpisah dari baseline traffic), source_ref (uuid nullable)

**bandwidth_measurements**: id (PK, uuid), source_label, target_label, target_host (nullable untuk legacy), connection_type (`wifi`/`ethernet`, nullable untuk legacy), bitrate_mbps, jitter_ms, measured_at

**hop_measurements**: id (PK, uuid), session_id (uuid, kelompokin per satu run `mtr`), source_label (nullable untuk legacy), target_label (nullable untuk legacy), target_host (nullable untuk legacy), connection_type (`wifi`/`ethernet`, nullable untuk legacy), hop_number, hop_ip, avg_latency_ms, loss_percent, measured_at. Context sesi diulang konsisten pada setiap row hop; belum memakai tabel sessions terpisah.

**network_nodes**: id (PK, uuid), ip_address (`inet`, host unik), name, device_type (`gateway`/`router`/`layer3_switch`/`managed_switch`/`server`/`firewall`/`access_point`/`workstation`/`printer`/`camera`/`iot`/`phone`/`unknown`/`other`, nullable), location (nullable), notes (nullable, inventory metadata saja), detected_fingerprint (jsonb normalized dan bounded, nullable), last_inspected_at (nullable), created_by (nullable FK ke profiles), created_at, updated_at. Approved user read-only; admin boleh create/update/delete. Operator identity tidak ditimpa oleh reinspection. Tidak menyimpan credential, secret, SNMP community string, raw scanner output, atau packet data.

**network_targets**: id (PK, uuid), node_id (FK `network_nodes`, unique bersama runner), runner_id (FK `diagnostic_runners`), enabled, critical, probe_method (`icmp` saja), probe_interval_seconds, timeout_ms, failure_threshold, recovery_threshold, latency_warning_ms, loss_warning_percent, created_by, created_at, updated_at. Approved user read; admin CRUD.

**network_health_latest**: target_id (PK/FK `network_targets`, tepat satu row per target), status (`online`/`degraded`/`offline`), latency_ms, packet_loss_percent, last_checked_at, last_success_at, consecutive_failures, sample_count (maksimal 5), updated_at. Browser approved read-only; write hanya melalui service-role runner endpoint.

**network_discovery_sessions**: runner_id (PK/FK `diagnostic_runners`, satu temporary slot per runner), session_id (uuid unik), requested_by, status (`idle`/`queued`/`running`/`completed`/`failed`/`expired`), phase (`prepare`/`scan`), connection/interface/local IPv4/subnet context, total/scanned/found count, results (jsonb bounded), error_code, created/started/completed/expires/updated timestamps. Admin read-only; mutation melalui Edge Function/service runner. Results dibersihkan saat expiry dan bukan inventory/history.

**device_inspection_sessions**: runner_id (PK/FK `diagnostic_runners`, satu temporary slot per runner), inspection_id (uuid unik), requested_by, target_ip, authorization_source (`discovery`/`inventory`), status (`queued`/`running`/`completed`/`failed`/`expired`), stage, result (normalized jsonb bounded 64 KiB), error_code, created/started/completed/expires/updated timestamps. Admin read-only; mutation hanya melalui Edge Function/service runner; payload expired dibersihkan setelah 10 menit dan tidak otomatis membuat inventory.

**managed_telemetry_targets**: id (PK, uuid), node_id (FK `network_nodes`, unique bersama runner), runner_id (FK `diagnostic_runners`), enabled, snmp_version (`2c`/`3`), snmp_port, credential_profile (text), poll_interval_seconds, thresholds (jsonb: errors/discards/up_percent/down_percent/util_percent), created_by, created_at, updated_at. Approved user read; admin CRUD via action. Tidak menyimpan secret/community string di kolom mana pun; `credential_profile` hanya nama profil lokal runner.

**managed_device_latest**: target_id (PK/FK `managed_telemetry_targets`, tepat satu row per target), connected (bool), polled_at, sys_name, sys_descr, sys_uptime_seconds, sys_object_id, sys_contact, sys_location, manufacturer, model, serial_number, firmware_version, num_physical_interfaces, num_logical_interfaces, updated_at. Browser approved read-only; write hanya melalui service-role runner endpoint.

**managed_interface_latest**: target_id (FK `managed_telemetry_targets`, unique bersama if_index), if_index, if_name, if_alias, if_type (`physical`/`logical`), if_speed, if_admin_status, if_oper_status, if_last_change, in_octets, out_octets, in_ucast_pkts, out_ucast_pkts, in_errors, in_discards, in_multicast_pkts, in_broadcast_pkts, rx_util_pct, tx_util_pct, rx_rate_bps, tx_rate_bps, updated_at. Browser approved read-only; write hanya melalui service-role runner endpoint; uptime-interval values (rx/tx rate/util) hanya snapshot latest dan bukan janji historis.

**diagnostic_runners**: id (PK, text), display_name, last_seen_at, health_status (`online`/`degraded`), health_error_code, capabilities (jsonb: source/target/duration allow-list untuk UI dan capability runtime Device Inspector yang ringkas; engine MVP `python_socket`, tool opsional tidak menjadi hard dependency), preflight (jsonb ephemeral satu slot untuk target allow-listed), created_at, updated_at

**diagnostic_jobs**: id (PK, uuid), runner_id, requested_by, status (`queued`/`running`/`completed`/`failed`), type (`bandwidth_and_path`), source_label, target_id, target_label, target_host, iperf_port, connection_type (hasil route Windows), duration_seconds, environment (`lan`/`localhost_demo`), stage, progress (jsonb sementara dan bounded), network_context (jsonb nullable untuk legacy), route_context (jsonb nullable untuk legacy), preflight_context (jsonb nullable untuk legacy), error_code, error_message, created_at, started_at, completed_at, updated_at

**traffic_live_sessions**: id (PK, uuid), runner_id, requested_by, status, duration_seconds, capture_scope (`this_device`), stage, error_code/message, created_at, started_at, expires_at, completed_at, updated_at. Selama status aktif, `updated_at` juga menjadi lease heartbeat dari snapshot live untuk recovery lock yatim.

**traffic_live_snapshots**: runner_id (PK), session_id, captured_at, summary (jsonb), flows (jsonb), conversations (jsonb), top_talkers (jsonb), payload_bytes, updated_at. Row bersifat ephemeral dan dioverwrite.

Tambahan flow live: `flows` memiliki nullable `runner_id`, `session_id`, stable directional `flow_key`, dan `peak_rate_mbps`. Unique `(session_id, flow_key)` dipakai untuk cumulative upsert; row legacy tetap nullable.

Tambahan measurement untuk one-click diagnostics: `bandwidth_measurements` memiliki `job_id`, `direction` (`upload`/`download`, nullable untuk legacy), `environment`, `peak_mbps`, `minimum_mbps`, `transferred_mb`, `retransmits` (sender-side TCP jika tersedia), dan `duration_seconds`; `hop_measurements` memiliki `job_id` dan `environment`. Row lama tetap nullable dan tidak diinterpretasikan ulang.

## 9. Klasifikasi severity (rule-based, awal)

| Severity | Kondisi |
|---|---|
| Low | Fluktuasi kecil, masih dalam baseline normal |
| Medium | Traffic > 1.5x baseline jam yang sama, atau latency naik signifikan |
| High | Packet loss signifikan, throughput drop tajam |
| Critical | `gateway_reachable = false` atau `dns_reachable = false` (not internet), atau anomali ekstrem |

Baseline dihitung dari rolling average (median per jam, 24-48 jam terakhir).

## 10. Alur registrasi & approval

1. User register lewat form Next.js (Supabase Auth).
2. Trigger database otomatis insert row `profiles` dengan status `pending`.
3. RLS memblokir akses data selama status belum `approved` — user melihat halaman "menunggu persetujuan".
4. Admin (Raka) membuka halaman Admin, melihat daftar pending, approve/reject.
5. Setelah `approved`, user bisa akses dashboard penuh sesuai role.

Admin pertama (Raka) di-seed manual lewat SQL editor Supabase setelah register pertama kali, bukan melalui logic otomatis di kode (menghindari race condition/celah keamanan).

## 11. Stack & deployment (semua free tier)

| Layer | Teknologi | Hosting |
|---|---|---|
| Frontend | Next.js | Vercel |
| Backend/DB/Auth/Realtime | Supabase | Supabase cloud (free tier) |
| AI Agent | Python Flask | Hugging Face Spaces |
| Local agent | Python (scapy/pyshark/psutil) | Laptop pribadi (portable) |
| API | RESTful | via Supabase REST + Flask endpoint |

## 12. Roadmap MVP

1. **Fondasi** — schema Supabase, auth + approval flow, agent versi basic (ping/psutil), dashboard status up/down.
2. **Traffic detail** — tambah scapy untuk flow table, halaman Traffic dengan search & filter.
3. **Klasifikasi & alert** — rule engine severity, halaman History & Alert.
4. **AI layer** — integrasi Hermes Agent untuk ringkasan otomatis per event.
5. **Bandwidth & path diagnostics (opsional, on-demand)** — job iperf3/mtr terpisah, tabel & halaman diagnostik baru, tidak masuk baseline severity.
6. **Operational network visibility** — Traffic pasif, selective Health Watch,
   on-demand bounded Network Discovery, dan Managed Infrastructure Telemetry (SNMP
   read-only, 7.11) tetap sebagai workflow terpisah.

## 13. Risiko & catatan teknis

- Free tier Supabase & HF Spaces punya batas resource dan bisa sleep saat idle — desain harus toleran terhadap ini (agent buffer lokal, Hermes dipanggil event-based bukan real-time).
- Menyimpan raw packet penuh akan membebani database — gunakan flow record ringkas.
- Definisi baseline/threshold sebaiknya terpusat di satu tempat (edge function), bukan di tiap agent, agar konsisten jika suatu saat ada lebih dari satu titik monitoring.
