# PLANNING.md — Task tracker

Dokumen ini pelacak progres, terpisah dari `PRD.md` (requirement) dan `AGENTS.md` (konvensi). AI assistant (Codex/ChatGPT/Claude) wajib update checklist ini — centang `[x]` setelah task benar-benar selesai & diverifikasi, jangan centang di depan. Jangan mulai task di fase berikutnya sebelum fase sebelumnya selesai, kecuali diminta lain oleh Raka.

Legenda: `[ ]` belum, `[~]` sedang dikerjakan, `[x]` selesai.

## Prioritas MVP — Reusable Quick Device Inspector

- [x] Architecture/docs: single-target bounded inspection, evidence/confidence model, detected vs operator identity, privacy, safety, dan reusable drawer
- [x] Migration `device_inspection_sessions` + bounded fingerprint pada `network_nodes`, RLS, Realtime, expiry, dan device type vocabulary
- [x] Edge Function structured inspection lifecycle, admin/service authorization, current Discovery/inventory target validation, busy guard, dan payload bounds
- [x] Agent collector: fixed probes, offline OUI, same-subnet/routed MAC safety, normalized evidence, classifier/confidence, partial failures, fixtures A–E
- [x] Existing runner operation `device_inspect`: fixed Windows context, WSL invocation, target revalidation, normalized capability preflight, stage/result transport, no raw output; unit test, live WSL inspection, heartbeat, dan live runner session terverifikasi
- [x] Reusable Device Profile drawer + explicit save/reinspect/Health Watch actions
- [x] Fingerprint Enrichment V1: bounded HTTP/HTTPS, TLS CN/SAN/issuer/validity, same-target UPnP, conditional NetBIOS hostname, service-state evidence, conservative classifier, partial-result UX, fixtures, controlled live inspection, dan regression
- [x] Discovery, Health Watch, LAN Diagnostic hop, dan Traffic memakai satu reusable Device Profile; authenticated browser E2E empat surface membuktikan navigation tetap di surface asal, Traffic/MTR tidak memulai Inspect otomatis, dan target monitored tidak menawarkan Add to Health Watch duplikat
- [x] Security/RLS/resource/regression dan remote deployment selesai; authenticated browser admin/viewer desktop/mobile lulus, self/virtual tampil faktual, tidak ada horizontal overflow, dan semua fixture exact-ID terhapus dengan delta events/traffic_metrics 0

**Definition of done:** admin dapat menginspeksi satu IP Discovery/inventory secara aman, melihat evidence normalized di reusable drawer tanpa refresh, menyimpan operator identity secara eksplisit, sementara viewer hanya membaca profile tersimpan dan workflow lain tidak berubah atau otomatis melakukan active scan.

---

## Fase 0 — Scaffolding

- [ ] Struktur folder `/agent`, `/frontend`, `/hermes-agent`, `/supabase` dibuat
- [ ] Next.js project init (App Router, TypeScript, Tailwind) dengan token warna & font dari `DESIGN.md`
- [ ] Route placeholder: `/dashboard`, `/traffic`, `/history`, `/alerts`, `/admin`
- [ ] Migration SQL awal: tabel `profiles`, `traffic_metrics`, `flows`, `events`
- [ ] RLS policy dasar + trigger auto-insert `profiles` status `pending`
- [ ] Skeleton `/agent/main.py` (belum ada logic asli)
- [ ] Skeleton Flask `/hermes-agent` dengan endpoint stub `/analyze`
- [ ] `.env.example` di tiap folder yang butuh

## Fase 1 — Fondasi (auth, status up/down)

- [ ] Halaman register/login pakai Supabase Auth
- [ ] Halaman "menunggu persetujuan" untuk user status `pending`
- [ ] Halaman Admin: list pending, tombol approve/reject (fungsional, bukan placeholder)
- [ ] Admin pertama (Raka) diseed manual lewat SQL — dicatat di sini setelah dilakukan
- [ ] Agent: implementasi ping ke gateway + resolve DNS, kirim hasil ke Supabase tiap interval
- [ ] Edge function `ingest`: terima data agent, simpan ke `traffic_metrics`, hitung status dasar (`normal`/`down`/`not_internet`) — belum perlu baseline rolling average, threshold sederhana dulu
- [ ] Dashboard: tampilkan status realtime + card metrik dasar (belum grafik traffic penuh)
- [ ] Realtime subscription frontend ke `traffic_metrics` berjalan

**Definition of done Fase 1:** Raka bisa buka dashboard dari laptop, lihat status jaringan naik/turun secara realtime, dan alur register→approval berfungsi end-to-end.

## Fase 2 — Traffic detail

- [x] Agent: capture Scapy directional 5-tuple header-only + local aggregation/rate
- [x] Agent: buffer SQLite coalescing, bounded retry/backoff
- [x] Edge function: bounded live session/snapshot + validated batch upsert `flows`
- [x] Runner: structured `traffic-live`, start/stop/timeout tanpa arbitrary command
- [x] Traffic session lock recovery: queued cancel langsung terminal, snapshot
  lease, dan orphan `running`/`stopping` auto-expire
- [~] Retention cleanup 48 jam + storage guardrail 300/400 MB
- [~] Halaman Traffic: capture state, overview, Live Flows, Conversations, Top Talkers, Flow Detail
- [~] Traffic Realtime satu snapshot subscription + reconnect/fallback
- [~] Mobile Traffic + load/resource/security/regression/browser verification

**Definition of done Fase 2:** Raka bisa cari & filter flow traffic real dari laptopnya sendiri di halaman Traffic.

## Fase 3 — Klasifikasi & alert

- [ ] Implementasi baseline rolling average (median per jam, 24-48 jam terakhir) di edge function
- [ ] Rule engine severity: low/medium/high/critical sesuai tabel di `PRD.md` bagian 9
- [ ] Insert otomatis ke tabel `events` saat threshold terlampaui
- [ ] Halaman History: list event, filter severity & tanggal, grouping by date
- [ ] Halaman Alerts: hanya event aktif (`resolved_at` null), tombol resolve berfungsi
- [ ] Notifikasi/badge status di top bar update sesuai severity tertinggi yang aktif

**Definition of done Fase 3:** Event penting otomatis tercatat dengan severity yang masuk akal, dan Raka bisa lihat riwayat serta alert aktif tanpa cek manual.

## Fase 4 — AI layer (Hermes Agent)

- [ ] Deploy Flask app ke Hugging Face Spaces
- [ ] Endpoint `/analyze` benar-benar ambil context history dari Supabase (bukan dummy lagi)
- [ ] Trigger pemanggilan Hermes saat event baru severity medium ke atas dibuat
- [ ] `ai_summary` tertulis kembali ke tabel `events`
- [ ] Halaman History/Alerts menampilkan `ai_summary` (tag "Hermes analysis" sesuai `DESIGN.md`)
- [ ] Uji cold-start HF Space free tier, pastikan tidak mengganggu alur utama saat Hermes sedang sleep

**Definition of done Fase 4:** Event penting otomatis dapat ringkasan/analisis dari Hermes Agent tanpa Raka perlu trigger manual.

## Fase 5 — Bandwidth & path diagnostics (opsional, on-demand)

- [x] Migration SQL: tabel `bandwidth_measurements`, `hop_measurements`
- [x] Agent: command terpisah (bukan bagian loop 10 detik) buat jalanin `iperf3 -c <target> -J` dan `mtr --json -c 5 <target>`
- [x] Agent: parsing hasil JSON, kirim ke endpoint baru (bukan `ingest` yang sama dengan traffic_metrics)
- [x] Endpoint/edge function baru: terima & simpan hasil, **tidak** ikut hitungan baseline rolling average
- [ ] Setup `iperf3 -s` di titik target (mis. server pusat) — dicatat di `AGENT_SETUP.md`
- [x] Halaman/komponen dashboard: chart bandwidth over time per titik uji + tabel hop latency per titik
- [x] Verifikasi: jalanin bandwidth test manual, pastikan **tidak** memicu event severity palsu di halaman Alerts
- [x] Context LAN diagnostics: simpan target asli + tipe koneksi eksplisit (`wifi`/`ethernet`) untuk bandwidth dan path; source/target context konsisten per sesi MTR
- [x] UI LAN diagnostics: filter source/target/connection, comparison latest bitrate lintas lokasi, dan timestamp/context path yang jelas
- [x] Verifikasi LAN diagnostics MVP: legacy `null`, upload/read WiFi, data uji Ethernet, invalid type ditolak, filter/comparison lulus, dan isolation events/traffic_metrics tetap terjaga
- [x] One-click schema: `diagnostic_runners`, `diagnostic_jobs`, Realtime/RLS, direction + final bandwidth stats, dan job linkage measurement
- [~] Edge Function job lifecycle: approved-user create/read + service-role heartbeat/claim/progress/complete/fail dengan validasi terstruktur
- [x] Agent streaming CLI: upload + reverse/download + MTR, JSON Lines normalized, final measurement semantics tetap di agent
- [x] Windows Local Diagnostic Runner: preflight, heartbeat, local allow-list, safe `wsl.exe --exec`, progress forwarding, dan safe errors
- [x] Windows Task Scheduler: install/start/status/remove auto-start runner saat login
- [~] `/diagnostics`: runner health, run form, Realtime live stages/Mbps, final result, localhost warning, error states, history/filter/comparison
- [x] Dashboard: compact latest diagnostics summary + link, tanpa active workflow penuh
- [~] History Diagnostic Tests: filter periode/source/target/connection/environment,
  grouping upload+download per `job_id`, summary, trend chart, recent tests, dan
  detail hop sudah diimplementasikan serta lolos automated test/build; visual
  authenticated-browser desktop/mobile masih perlu verifikasi manual
- [x] Localhost one-click E2E: temporary owned server, upload/download/MTR, cleanup, measurement persistence, Realtime progress
- [~] Security/isolation verification: invalid/unauthorized jobs ditolak, no arbitrary command, events/traffic_metrics tetap tidak berubah
- [x] Windows network context collector: actual route adapter, IPv4/prefix/subnet,
  gateway, DNS, local link speed, optional WiFi context, tanpa inferensi WSL `eth0`
- [x] Target route + bounded preflight: on-link/routed, source IP/interface,
  next hop/metric, ICMP cautious semantics, dan TCP iperf3 readiness
- [x] Diagnostic context persistence: nullable JSONB `network_context`,
  `route_context`, `preflight_context`; legacy job tetap kompatibel
- [x] Production/demo gating: localhost dan Local Development tersembunyi default,
  hanya aktif eksplisit dengan `ENABLE_DIAGNOSTIC_DEMO=true`
- [~] Real-target LAN Diagnostics UX: Current Network, target/route/preflight,
  actual detected connection, conservative result interpretation; automated
  test lulus, authenticated desktop/mobile browser E2E masih pending
- [x] Manual network hop labeling: reusable `network_nodes`, approved read/admin
  CRUD RLS, ordered SOURCE→hop→TARGET display, Unknown node behavior, dan dynamic
  lookup untuk current/history tanpa denormalisasi `hop_measurements`

**Definition of done Fase 5:** Raka bisa jalanin test bandwidth & path on-demand dari agent, lihat hasilnya di dashboard, tanpa itu mengganggu status/severity jaringan normal.

## Prioritas MVP — Lightweight Network Health Watch

- [x] Migration `network_targets`, `network_health_latest`, typed event source, RLS, index, dan Realtime
- [x] Edge Function service-role `network-health`: list allow-listed targets, latest batch upsert, transition event dedupe/resolution
- [x] Runner scheduler non-blocking: fixed Windows ICMP, concurrency 4, bounded timeout, state window 5, transition-only queue, retry/backoff
- [x] Runner unit/regression test: threshold/recovery, degraded, multiple target, coalescing/backoff, non-blocking, dan safe invocation
- [x] Dashboard utama: summary, critical/other target, responsive table/card, detail, cautious ICMP semantics, satu Realtime channel
- [x] Admin existing page: assign inventory node ke runner, enable/disable, critical flag, interval/timeout/failure/recovery/latency/loss thresholds
- [x] Alerts aktif dan History event menggunakan `events.source = network_health`; recovery resolve event terdahulu
- [x] Remote migration/function deploy dan RLS/service-role verification
- [x] Controlled runner E2E: healthy, degraded/offline, recovery, restart persistence, multi-target, backend outage, dan heartbeat/job responsiveness
- [~] Frontend production build lulus; authenticated desktop/mobile visual verification masih manual
- [x] Resource estimate aktual dicatat setelah jumlah target enabled final diketahui

**Definition of done:** target inventory yang disetujui terlihat secara realtime di Dashboard tanpa per-ping row/event, status pulih stabil, runner tetap responsif untuk Traffic/Diagnostics, dan tidak ada coupling ke baseline severity traffic.

## Prioritas MVP — On-demand Network Discovery

- [x] Migration temporary single-slot `network_discovery_sessions`, admin-read RLS,
  Realtime, expiry cleanup, dan tambahan node type workstation/printer
- [x] Edge Function `network-discovery`: admin prepare/start, service claim/progress/
  complete/fail, runner busy guard, payload/scope bounds
- [x] Windows runner discovery: fixed context helper, neighbor + ICMP `/24`–`/30`,
  concurrency 4, timeout 400 ms, dedupe, progress setiap 32 alamat, no recurring sweep
- [x] Dashboard order dan Local Traffic summary: Observed RX/TX, active flow, top talker,
  capture-stopped state, tanpa developer deployment copy
- [x] Admin discovery drawer: context, progressive temporary results, empty/error/expired
  states, responsive table/card, Admin-only action
- [x] Selective promotion: Give Name memakai `network_nodes`, explicit Add to Health Watch
  memakai `network_targets`, bulk hanya untuk node bernama, Traffic correlation by IP
- [x] Verification: RLS/security/scope/expiry/resource bounds, Realtime, regression Health/
  Traffic/Diagnostics, lint, typecheck, production build, runner/frontend tests, browser E2E

**Definition of done:** satu discovery ringan dapat dijalankan admin pada subnet Windows
tervalidasi, hasil muncul progresif dan hilang setelah expiry, serta tidak ada host menjadi
inventory/monitoring tanpa pilihan eksplisit.

## Prioritas MVP — Managed Infrastructure Telemetry (SNMP read-only)

- [x] Migration `202608160001_managed_infrastructure_telemetry.sql`
  (`managed_telemetry_targets`, `managed_device_latest`, `managed_interface_latest`,
  RLS, index, Realtime): diterapkan manual oleh Raka dan terverifikasi remote —
  tabel ada, RLS approved-read untuk admin/viewer fixture (HTTP 200), dan Realtime
  latest-state terverifikasi lewat browser E2E tanpa refresh
- [x] Agent SNMP collector read-only: OID tetap dan terbatas, normalisasi interface
  fisik/logis, tanpa SET/walk bebas/LLDP/topology; unit tests fixture lulus
- [x] Runner scheduler telemetry terpisah: polling bounded per target enabled,
  credential profile lokal (`monitoring-readonly`/`core-readonly`), counter cache
  lokal, latest-state upsert, event `source = managed_telemetry` hanya transisi;
  unit/regression tests lulus
- [x] Frontend helper `managed-telemetry.ts`: threshold fixed, formatter, credential
  profile status, warning interface; unit tests lulus
- [x] Device Profile bagian Managed Infrastructure Telemetry: status koneksi target,
  identitas/uptime, tabel interface + utilisasi/error/discard + peringatan, satu
  subscription Realtime; lint, typecheck, production build, dan unit tests lulus
- [x] Admin config UI `/admin#managed-telemetry`: tambah/ubah/nonaktifkan target dari
  `network_nodes`, pilih runner + SNMP version + credential profile (nama saja, tanpa
  secret), action `saveManagedTelemetryTargetAction` dengan RLS approved-read;
  lint, typecheck, production build, dan unit tests lulus
- [x] Authenticated browser E2E synthetic `scripts/verify_managed_telemetry_browser.mjs`
  lulus: admin config form, Device Profile telemetry section, physical/logical
  semantics, interface table/detail, null util, Realtime tanpa refresh, viewer
  read-only, desktop/mobile tanpa overflow, tidak ada secret di DOM, smoke Traffic/
  Diagnostics/Dashboard, dan Device Inspector surface tetap tampil; tanpa probe
  SNMP/UDP-161 nyata dan tanpa ping/MTR/iperf3/capture/Device Inspector probe
- [~] Edge Function `managed-telemetry`: IMPLEMENTED + CONTRACT/UNIT VERIFIED, tetapi
  **belum runtime/deployment verified dan belum di-deploy**

**Definition of done:** admin dapat menambah target telemetry dari inventory untuk runner
ber-profil lokal, runner mem-poll read-only bounded dan menyimpan latest-state, Device
Profile menampilkan telemetry perangkat secara realtime dengan peringatan interface,
approved viewer hanya membaca, dan tidak ada secret di Supabase/browser serta tidak ada
row per poll. (Tercapai untuk frontend/runner/agent/schema; deployment Edge Function
sengaja ditunda.)

---

## Catatan tambahan

- [2026-08-18] Fingerprint Enrichment V1 selesai tanpa migration/dependency baru dan
  tanpa Nmap. Fixed allow-list menjadi TCP 22/80/443/445/554/631/1883/8080/8443/9100,
  SSDP unicast UDP/1900, serta NetBIOS Node Status UDP/137 hanya ketika SMB terbuka.
  HTTP/HTTPS bounded tidak mengikuti redirect dan menghapus query/credential dari
  Location; TLS menormalisasi CN/SAN/issuer/validity; UPnP hanya mengambil description
  dari IP target yang sama dan fixture malicious LOCATION membuktikan fetch eksternal
  tidak dilakukan. Fixture TP-Link/Laragon/PoliKlinikk/randomized-MAC/routed-target
  lulus. Controlled live collector ke inventory PoliKlinikk selesai 10,8 detik:
  SMB/445 open, HTTP/TLS/UPnP/NetBIOS identity tidak terpapar, hasil complete partial
  `unknown`/LOW tanpa raw output. Context helper production pada saat pengecekan live
  terpisah mengembalikan `INSPECTION_NETWORK_CONTEXT_UNAVAILABLE`, sehingga tidak ada
  remote session/Supabase write dan tidak diklaim sebagai browser/production E2E baru.
  Full agent suite 47 test (1 opt-in skip), runner 31, frontend 27, lint, typecheck,
  dan production build lulus; source Edge Function yang memperbolehkan capability
  collector baru belum dideploy pada task ini.
- [2026-08-18] Device Inspector live runner selesai diperbaiki dan diverifikasi pada
  node inventory `PoliKlinikk` (`192.168.188.249`). Root cause
  `INSPECTION_CONTEXT_UNAVAILABLE` adalah `Find-NetRoute` mengembalikan gabungan
  `MSFT_NetIPAddress` dan `MSFT_NetRoute`; pembacaan `InterfaceIndex` dari array
  menghasilkan `System.Object[]` dan menggagalkan `Get-NetIPConfiguration`. Helper
  sekarang memilih kedua CIM object secara eksplisit. Capability startup memakai
  `network-monitor capabilities`: engine `python_socket`, Python 3.12.13, OpenSSL dan
  Scapy OUI tersedia; Nmap 7.80/curl tersedia tetapi tidak digunakan; arp-scan,
  nbtscan, dan mDNS tidak wajib. Live helper menghasilkan source
  `192.168.188.180/24`, on-link, MAC target valid; CLI dan temporary runner session
  menghasilkan partial fingerprint SMB/TCP 445, stage `complete`, authorization
  `inventory`, tanpa raw output, tanpa mengubah operator identity, serta delta
  `events=0` dan `traffic_metrics=0`. `diagnostic-jobs` dan `device-inspector` sudah
  dideploy ulang tanpa migration baru; heartbeat remote online dan capability tersimpan.
  Agent 41 test (1 opt-in skip), runner 31 test, frontend 25 test, lint, typecheck, dan
  production build lulus. Authenticated browser automation nyata belum diklaim lulus:
  verifier dapat login dan melihat target tetapi pemicu row headless tidak membuka
  drawer; percobaan/akun sementara dibersihkan dan script gagal tidak disimpan.
- [2026-08-15] Quick Device Inspector migration `202608150001` dan Edge Functions
  `device-inspector`, `network-discovery`, `traffic-live`, serta `diagnostic-jobs` aktif
  pada project `krsixpywzeqazuhrgvib`. Remote RLS/security fixture lulus: viewer active
  inspect/temp read/write ditolak, admin inventory/discovery target diterima, Internet IP
  dan command/flags/ports/NSE/URI/CIDR ditolak, raw output ditolak, temporary result tidak
  membuat/mengubah inventory, events/traffic_metrics delta 0. Payload fixture temporary
  dan persisted masing-masing 686 byte; estimasi 100 fingerprint sekitar 0.065 MiB sebelum
  overhead database.
- [2026-08-15] Authenticated Chrome E2E Dashboard lulus untuk unknown Inspect/Beri nama,
  drawer terbuka langsung, progress, Realtime result tanpa refresh, evidence/type/
  confidence/capabilities, explicit Save identity, Detail reopen, Add to Health Watch,
  dan mobile tanpa horizontal overflow. Frontend tests/lint/typecheck/Turbopack build dan
  seluruh 27 runner unit tests lulus; delapan Device Inspector agent fixtures lulus pada
  Python host. Restart runner saat verifikasi terakhir gagal preflight `AGENT_VENV_MISSING`
  karena WSL command juga keluar tanpa output dari sesi automation. Oleh karena itu live
  WSL Device Inspect dan browser-specific checks dari Health/Traffic/LAN hop tetap `[~]`;
  tidak diklaim selesai atau disimulasikan.
- Setiap kali sebuah task selesai, update checklist ini di commit yang sama dengan kodenya — jangan biarkan file ini basi/tidak sinkron dengan kondisi repo.
- [2026-08-15] Runner heartbeat pulih. Root cause adalah kontrak capability yang tidak sinkron: runner mengirim operasi keempat `device_inspect`, sedangkan validator `diagnostic-jobs` yang sudah dideploy masih mengharuskan tepat tiga operasi lama dan mengembalikan HTTP 400 `Runner operations are invalid`. Validator serta safe heartbeat logging diperbaiki, `diagnostic-jobs` dideploy ulang, 28 runner tests lulus, Scheduled Task direstart, dan backend terverifikasi `online` dengan heartbeat age 9 detik. Live Device Inspect belum dijalankan sehingga item operasi tetap `[~]`.
- Kalau ada keputusan yang menyimpang dari `PRD.md`/`AGENTS.md`/`DESIGN.md` di tengah jalan, catat alasannya singkat di bagian ini sebelum lanjut, dan konfirmasi ke Raka.
- [2026-08-11] Target iperf3/mtr asli masih pending izin dari B (belum dapat
  PC/VM di LAN yang confirmed boleh dipakai bebas). Sementara pipeline
  divalidasi pakai localhost sebagai target. Checklist "Setup dan verifikasi
  iperf3 -s pada target nyata" tetap [ ] sampai target asli confirmed dan
  diverifikasi — jangan dicentang walau localhost sudah jalan mulus.
- [2026-08-11] UI diagnostik Fase 5 selesai dan terverifikasi. Migration dan
  function diagnostics sudah aktif di project Supabase `krsixpywzeqazuhrgvib`.
  Path dan bandwidth test localhost berhasil end-to-end melalui agent →
  function → tabel diagnostics. Bandwidth test upload menghasilkan tepat satu
  row `bandwidth_measurements` (`53.770451 Mbps`), sementara jumlah `events`
  dan `traffic_metrics` tetap 0. Target eksternal tetap belum diverifikasi dan
  checklist setup target nyata tetap [ ].
- [2026-08-11] LAN diagnostics MVP ditambah context eksplisit `wifi`/`ethernet`,
  target asli (`target_host`), filter, comparison latest bitrate lintas lokasi,
  dan context sesi MTR. Migration serta Edge Function sudah diterapkan ke project
  Supabase terhubung. Row legacy tetap `null`; tidak ada backfill tipe koneksi.
  Upload/read WiFi dan Ethernet diverifikasi memakai fixture sintetis yang kemudian
  dibersihkan, bukan pengukuran Ethernet fisik. Nilai invalid dan context sesi MTR
  yang tidak konsisten ditolak HTTP 400. Count `events` dan `traffic_metrics`
  tetap 0 sebelum/sesudah test. Belum ada klaim bottleneck LAN nyata; target
  iperf3 eksternal masih menunggu otorisasi.
- [2026-08-11] One-click localhost pipeline berhasil melalui Windows runner →
  `wsl.exe --exec` → persistent agent venv → iperf3 JSON stream/MTR → endpoint
  diagnostics. Job `3f8419c5-0b9c-48e3-8a47-877e974cd37e` menyimpan dua row
  receiver throughput (upload `54.067161 Mbps`, download `159.971681 Mbps`) dan
  satu hop localhost (`0.209 ms`, loss `0%`); live Mbps teramati dan progress
  sementara dibersihkan saat complete. Delta `events` dan `traffic_metrics`
  tetap 0. Port 5201 ternyata sudah dipakai proses existing dan sengaja tidak
  dibunuh; demo terverifikasi memakai port 5202 lalu temporary server bersih.
  Task Scheduler user-level `Network Monitoring Local Runner` sudah terpasang
  dan aktif. Verifikasi klik `Jalankan diagnostik` dari sesi browser admin belum
  dilakukan, sehingga item Edge user create/read, `/diagnostics`, dan security
  end-to-end tetap `[~]`, bukan diklaim selesai. Target eksternal tetap `[ ]`.
- [2026-08-11] Status runner yang berubah `OFFLINE` selama diagnostic job
  disebabkan heartbeat berada di polling loop yang ikut menunggu proses
  upload/download/MTR. Heartbeat runner sekarang memakai timer independen dan
  job localhost `03f34693-8cc1-4449-b13e-154f76108098` terverifikasi melewati
  `queued` → `preparing_runner` → `starting_wsl` → `checking_target` →
  `upload` → `download` → `mtr` → `saving` → `complete`, dengan live Mbps
  teramati dan umur heartbeat maksimum `10.2` detik (batas offline `30` detik).
  Delta `events` dan `traffic_metrics` tetap `0`. Frontend test, lint,
  typecheck, dan production build lulus. Verifikasi klik dari browser admin
  untuk UX progress terbaru masih pending, jadi checklist `/diagnostics` dan
  user-facing Edge flow tetap `[~]`.
- [2026-08-11] `/history` mempertahankan tab Network Events dan menambahkan tab
  Diagnostic Tests. Query history memakai Edge Function `diagnostics` yang sama,
  berbatas rentang waktu dan maksimal 100 completed job. Upload/download serta
  hop dikorelasikan lewat `job_id`; `localhost_demo` dikecualikan default.
  Fixture WiFi/Ethernet/localhost hanya dipakai dalam unit test dan tidak
  dipersist ke Supabase. Frontend test, lint, typecheck, build, deployment
  function v6, CORS 204, dan unauthenticated rejection 401 terverifikasi.
- [2026-08-12] Traffic capture pipeline diverifikasi terpisah dari diagnostics
  dan severity. Root cause pesan `Traffic operation is not authorized by runner`
  adalah normalisasi capability Edge Function yang sebelumnya hanya menerima
  `bandwidth_and_path`; validator kini menerima allow-list terkontrol
  `traffic_live` dan durasi 300/600/900/1800 detik. Runner terverifikasi
  `Running`, heartbeat `online`, dan capability remote sudah memuat
  `traffic_live`. Controlled session `29b4c106-4277-48d3-9b49-b306dd872181`
  mencapai capture, mengirim snapshot terstruktur (6 flow, 3 conversation,
  4 top talker), menerima stop, lalu selesai tanpa menambah row `events` atau
  `traffic_metrics`. Batch lebih dari 100 flow ditolak HTTP 400. Agent 31 test
  lulus (1 integration test opt-in dilewati), runner 7 test lulus, dan frontend
  15 test, lint, typecheck, serta production build lulus. Fungsi retention dan
  cron sudah dimigrasikan, tetapi eksekusi cleanup terhadap data remote yang
  sengaja dibuat kedaluwarsa belum dilakukan; item retention tetap `[~]`.
  Klik capture dari authenticated browser setelah capability fix dan verifikasi
  visual desktop/mobile masih perlu dilakukan, sehingga checklist UI, Realtime,
  dan browser verification tetap `[~]`.
- [2026-08-12] Launcher harian kini dapat dipanggil langsung dari Windows dengan
  `python scripts\\start_diagnostics.py` tanpa virtualenv atau dependency Python
  global. Proses Windows hanya mendelegasikan ke `start-diagnostics.ps1`, lalu
  memakai `agent/.venv` di WSL seperti arsitektur runner semula. Command persis
  tersebut terverifikasi mendeteksi Scheduled Task, menyalakan runner, dan
  memperoleh heartbeat `ONLINE` berumur 4,7 detik.
- [2026-08-12] LAN Diagnostics real-network upgrade diterapkan. Migration
  `202608120002` aktif; Edge Functions `diagnostic-jobs` dan `diagnostics`
  sudah dideploy aktif. Fixed Windows collector terverifikasi nyata pada WiFi host ini:
  `192.168.188.180/24`, gateway/DNS `192.168.188.50`, local link 1201 Mbps,
  dengan route localhost on-link. Ethernet/routed/no-ICMP-response diverifikasi
  melalui fixture karena adapter Ethernet fisik sedang disconnected. Mode normal
  menerbitkan target/source kosong (localhost tersembunyi), durasi 5/10 detik,
  sehingga UI menampilkan setup state sampai Server 253 yang sah ditambahkan.
  Context JSONB, actual connection detection, admin-only active start, satu job
  aktif per runner, local allow-list resolution, dan no arbitrary shell tetap
  berlaku. Runner 10 test lulus; frontend 15 test, typecheck, dan lint lulus.
  Production build pertama terhenti karena disk hanya tersisa ~663 MB; generated
  `.next` ~639 MB dibersihkan secara recoverable, lalu build retry terhalang fetch
  Google Fonts/network dan timeout, sehingga build final belum diklaim lulus.
  Count remote `events=0` dan `traffic_metrics=0` tetap tidak berubah.
  Runner Scheduled Task saat akhir verifikasi belum kembali online karena WSL
  mount/start macet (`AGENT_VENV_MISSING`); broad `wsl --shutdown` tidak dijalankan
  tanpa izin eksplisit. Target Server 253, izin, iperf3 server, real LAN test,
  browser E2E, dan mobile visual tetap pending.
- [2026-08-14] Manual reusable hop labeling selesai. Migration
  `202608140001_network_nodes.sql` diterapkan dan tercatat pada Supabase project
  `krsixpywzeqazuhrgvib`. `network_nodes.ip_address` memakai host-only `inet`
  unik; approved viewer SELECT-only dan approved admin CRUD. Remote verification
  dengan akun admin/viewer sementara membuktikan duplicate IPv4 ditolak, IPv6
  diterima, rename/delete bekerja, viewer mutation ditolak, dan akun/fixture
  dibersihkan setelah test. Count `hop_measurements`, `events`, dan
  `traffic_metrics` tidak berubah. Current dan History resolve label secara
  dinamis tanpa mengubah row hop. Frontend 21 test, lint, typecheck, production
  build, runner 10 test, serta agent 31 test lulus (1 integration opt-in skip).
- [2026-08-14] Traffic runner lock recovery selesai dan aktif di Supabase.
  Root cause session `ef6678c7-123c-41cb-8b6d-6f63d54a00d3` adalah stop ketika
  masih queued: `started_at`/`expires_at` null membuat state `stopping` tidak
  pernah memenuhi cleanup lama. Session tersebut dipulihkan menjadi `expired`
  dengan code `SESSION_ORPHANED`. Stop-before-claim sekarang langsung terminal;
  snapshot 2 detik memperbarui lease; heartbeat runner, claim, create/read API,
  dan cleanup merekonsiliasi orphan tanpa mengabaikan capture aktif. Remote E2E
  membuktikan queued stop meninggalkan 0 active lock, fresh lease dipertahankan,
  stale lease dipulihkan, fixture dibersihkan, serta delta `events=0` dan
  `traffic_metrics=0`.
- [2026-08-14] Implementasi lokal Network Health Watch memakai database target
  allow-list, bukan subnet scan. Default cadence 30 detik (critical 15 detik),
  concurrency 4, short window 5, offline setelah 3 failure, recovery setelah 2
  success, latest upsert maksimal satu row per target, dan event hanya transisi.
  Migration/function belum dianggap selesai sampai remote deploy/RLS/E2E lulus.
- [2026-08-14] Network Health Watch remote verification selesai. Migration
  `202608140003_network_health_watch.sql` dan Edge Function `network-health`
  aktif di project `krsixpywzeqazuhrgvib`. Fixture membuktikan enabled-only list,
  satu latest row per target, invalid payload ditolak, transition idempotent,
  recovery resolve, viewer read-only, admin config, dan untrusted publish ditolak.
  Live runner dua target membuktikan concurrent ONLINE/OFFLINE, threshold 3,
  recovery 2, persistence setelah restart, heartbeat tetap fresh, serta tidak
  mengubah `traffic_metrics`/event non-health. Semua fixture dibersihkan; kondisi
  akhir 0 target enabled, 0 latest row, dan 0 health event. Frontend 21 test,
  lint, typecheck, production build; runner 18 test; agent 31 test (1 opt-in
  integration skip) lulus. Visual authenticated desktop/mobile masih manual.
  Resource saat ini 0 probe/write/event per menit. Contoh 12 target (4 critical
  @15s, 8 normal @30s): 32 probe/menit, maksimal 12 latest-row upsert/menit dalam
  satu batch, sekitar 2 Edge request/menit (refresh + publish), 12 latest row
  tetap, dan 0 event pada kondisi healthy stabil.
- [2026-08-14] UX Admin dan LAN Diagnostics dirapikan tanpa perubahan schema
  atau pipeline. Form tambah Network Health kembali ke placeholder kosong;
  target tersimpan memakai desktop table/mobile card dan form edit tunggal yang
  dibuka melalui action `Edit`. Panel active/latest diagnostic tidak lagi
  mengulang visual path penuh; detail MTR berada di `Riwayat hasil per sesi`,
  collapsed default dan dibuka satu per satu. State measurement dibagi melalui
  `DiagnosticsWorkspace`, sehingga hasil baru memperbarui latest dan history
  tanpa page refresh. Frontend 21 test, lint, typecheck, dan production build
  lulus; inspeksi visual authenticated tetap dapat dilakukan dari browser lokal.
- [2026-08-14] On-demand Network Discovery selesai dan aktif. Migration
  `202608140004_network_discovery.sql`, Edge Function `network-discovery`, serta
  compatibility capability `diagnostic-jobs` sudah dideploy ke project
  `krsixpywzeqazuhrgvib`. E2E nyata memakai route Windows WiFi
  `192.168.188.180/24`: 254 usable host diperiksa sekali dengan concurrency 4,
  9 host terlihat, hasil terdeduplikasi, viewer dan browser CIDR `/8` ditolak,
  unknown host tidak otomatis masuk `network_nodes`/`network_targets`, promotion
  eksplisit admin lulus, dan temporary payload dibersihkan setelah expiry.
  Fixture user/node/target/browser profile dibersihkan; delta `events=0` dan
  `traffic_metrics=0`. Authenticated headless Chrome desktop/mobile membuktikan
  urutan Dashboard, Local Traffic RX/TX copy, Admin-only drawer, tidak ada input
  arbitrary scope, dan tidak ada horizontal overflow pada viewport 390px.
  Frontend 23 test, lint, typecheck, production build, serta runner 22 test lulus.
- [2026-08-18] Reusable Quick Device Inspector direkonsiliasi terhadap source,
  deployment, runner nyata, tests, dan dokumen. `device-inspector` remote v2
  sudah identik dengan source; hanya `diagnostic-jobs` yang stale lalu dideploy
  menjadi v14 ACTIVE dengan JWT verification aktif. Helper produksi berhasil
  untuk target inventory on-link `192.168.188.249` melalui Wi-Fi fisik dan untuk
  self address `192.168.112.1` melalui `vEthernet (WSL (Hyper-V firewall)) 2`;
  target kedua menghasilkan `This Device`, `interface_type=virtual`, MAC null,
  tanpa hardcode IP. Dua E2E runner→helper→WSL→agent→Supabase selesai dengan
  authorization source inventory, operator identity tetap, raw output tidak ada,
  serta delta events dan traffic_metrics masing-masing 0. Remote security verifier
  membuktikan admin/viewer/RLS, target authorization, injection rejection,
  lifecycle service-role, payload 686 byte, explicit save, dan viewer read-only.
  UX kini memberi warning bila kategori operator bertentangan dengan role self,
  memakai copy `Save detected evidence`, dan menyembunyikan Add to Health Watch
  untuk target enabled. Agent 49 test (1 skip), runner 32 test, frontend 32 test,
  lint, typecheck, build, syntax verifier, dan diff check lulus. Authenticated
  authenticated browser E2E empat surface kemudian lulus memakai fixture marker
  unik `e2e-device-profile-*`: Discovery, Health Watch, Traffic, dan LAN
  Diagnostic hop membuka reusable Device Profile; admin active Inspect dan viewer
  read-only lulus; Traffic serta hop tidak memulai Inspect otomatis; target yang
  sudah dimonitor tidak menawarkan Add to Health Watch duplikat; self/virtual
  tampil sebagai `This Device` dan `virtual`; desktop/mobile tidak overflow.
Traffic snapshot, hop, diagnostic job, Health target/latest, runner, discovery,
   inspection session, dan user fixture hanya data terkontrol; tidak ada network
   probe, packet capture, iperf3, atau MTR yang dijalankan. Cleanup `finally`
   berbasis ID terverifikasi untuk seluruh fixture, audit marker pasca-run bersih,
   count operasional kembali ke baseline, dan delta events/traffic_metrics 0.
- [2026-08-19] Managed Infrastructure Telemetry (SNMP read-only) fase 1 selesai
  diimplementasikan dan diverifikasi lokal. Frontend Device Profile bagian telemetry,
  Admin config UI, helper `managed-telemetry.ts`, agent SNMP collector read-only
  (OID tetap, tanpa SET/LLDP/topology), dan runner scheduler telemetry (credential
  profile lokal, counter cache, latest-state upsert, event transisi) lulus unit test,
  lint, typecheck, dan production build; total frontend 44 test lulus. Migration
  `202608160001_managed_infrastructure_telemetry.sql` diaudit dan aman (additive/
  scoped), tetapi **belum diterapkan ke project `krsixpywzeqazuhrgvib` — diterapkan
  manual oleh Raka**, sehingga schema/RLS/Realtime remote verification masih pending.
  Edge Function `managed-telemetry` tetap **belum di-deploy** (IMPLEMENTED +
  CONTRACT/UNIT VERIFIED only). Browser E2E synthetic
  `scripts/verify_managed_telemetry_browser.mjs` sudah ditulis dan lolos syntax check,
  tetapi **belum dijalankan** sampai migration diterapkan; E2E hanya memakai fixtures
  synthetic dengan marker unik, tanpa probe SNMP/UDP-161 nyata, tanpa ping/MTR/
  iperf3/packet capture/Device Inspector probes, dan membersihkan semua fixture
  berbasis exact ID. Tidak ada secret SNMP di Supabase/browser; hanya nama credential
  profile lokal runner yang disimpan.
- [2026-08-19] Authenticated browser E2E synthetic Managed Infrastructure Telemetry
  lulus setelah migration `202608160001` diterapkan manual oleh Raka. Marker unik
  `e2e-managed-telemetry-*`: admin config form tersimpan dan muncul di daftar,
  Device Profile menampilkan status Connected + identitas sistem + uptime + tabel
  interface (10 total, 8 physical, 7 up/1 down, errors 1, discards 2, null util
  sebagai "—" bukan 0%), interface detail dengan warning link issue/speed changed/
  logical, Realtime update device/interface tanpa refresh (pathname+timeOrigin sama),
  viewer read-only tanpa kontrol admin dan tanpa secret di DOM, desktop/mobile tanpa
  horizontal overflow, Device Inspector surface tetap menampilkan stored evidence
  tanpa probe, dan smoke Traffic/Diagnostics/Dashboard tetap berfungsi. Semua
  assertion lulus; fixture dibersihkan exact-ID (16 cek `true`), audit marker pasca-run
  `clean: true`, dan operational counts kembali ke baseline dengan delta events = 1
  (hanya fixture speed event). Tidak ada SNMP/UDP-161, ping, MTR, iperf3, packet
  capture, atau Device Inspector probe yang dijalankan.
