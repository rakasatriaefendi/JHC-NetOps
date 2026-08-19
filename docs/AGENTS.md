# AGENTS.md — Panduan untuk AI coding assistant

Dokumen ini untuk AI assistant (ChatGPT, Claude, Cursor, dll) yang membantu membangun project **Network Traffic Monitoring Dashboard**. Baca `PRD.md` dulu untuk konteks lengkap sebelum mulai coding.

## Struktur project yang disarankan

```
/agent          -> local capture agent (Python, jalan di laptop)
/frontend        -> Next.js dashboard (deploy ke Vercel)
/hermes-agent     -> Flask AI agent (deploy ke Hugging Face Spaces)
/supabase        -> schema SQL, migration, edge functions, RLS policy
PRD.md
AGENTS.md
```

## Aturan umum

1. **Jangan simpan raw packet capture penuh ke database.** Hanya simpan flow record ringkas (5-tuple + size + timestamp) di tabel `flows`. Kalau butuh detail lebih dalam, itu tetap di sisi agent/lokal, bukan di Supabase.
2. **Logic threshold/baseline severity harus terpusat** di edge function Supabase (`/supabase/functions/ingest`), bukan hardcode di agent Python. Ini supaya definisi "normal vs high traffic" konsisten walau nanti ada lebih dari satu agent.
3. **RLS wajib aktif** di semua tabel operasional (`traffic_metrics`, `flows`, `events`). Akses hanya untuk `profiles.status = 'approved'`. Role `admin` punya akses tambahan ke tabel `profiles` untuk approve/reject.
4. **Jangan buat logic "auto-admin" otomatis di kode.** Admin pertama diseed manual lewat SQL, dijelaskan di PRD bagian 10.
5. **Agent Python harus punya buffer lokal** (SQLite/file) untuk toleransi saat koneksi ke Supabase terputus — retry saat online kembali, jangan drop data begitu saja.
6. **Hermes Agent dipanggil event-based**, bukan polling terus-menerus. Trigger hanya saat ada row baru di `events` dengan severity `medium` ke atas.
7. Semua kolom fleksibel/tidak terstruktur (breakdown protokol, context event) pakai tipe `jsonb`, bukan kolom terpisah-pisah.
8. Ikuti skema tabel persis seperti di `PRD.md` bagian 8, kecuali ada diskusi ulang dengan Raka.
9. **Job bandwidth/path diagnostics (`iperf3`/`mtr`) harus terpisah total dari jalur `traffic_metrics`.** Jangan jalankan sebagai bagian dari loop agregasi 10 detik, dan jangan biarkan hasilnya ikut dihitung ke baseline rolling average di edge function `ingest` — test bandwidth sengaja generate traffic tinggi dan akan memicu event `medium`/`high` palsu kalau ikut campur ke perhitungan severity.
10. **Tipe koneksi one-click berasal dari route Windows aktual.** Runner mendeteksi
    `wifi`/`ethernet` dari adapter Windows yang dipilih route ke target allow-listed;
    jangan infer dari WSL `eth0` dan jangan menerima klaim manual browser. CLI agent
    tetap menerima tipe eksplisit dari runner. Simpan label lokasi manusia terpisah
    dari DHCP IP. Row legacy boleh memiliki context `null`.
11. **Browser/Vercel tidak boleh mengeksekusi command lokal.** One-click diagnostics hanya membuat structured job. Windows runner wajib menggunakan allow-list lokal dan memanggil executable agent WSL dengan argument list, `shell=False`, tanpa `bash -lc`, tanpa arbitrary command/flags.
12. **Runner hanya orchestration bridge.** Parsing `iperf3`/`mtr`, streaming normalization, dan diagnostic semantics tetap di `/agent`; jangan duplikasi parser jaringan di `/runner`.
13. **Target database tidak dipercaya untuk eksekusi.** Runner harus resolve `target_id` melalui konfigurasi lokal dan mengabaikan snapshot `target_host` job sebagai sumber command. Validate ulang source, target, duration, connection type, dan operation walaupun Edge Function sudah memvalidasi.
14. **Traffic capture adalah bounded session dan scope-nya This Device.** Jangan nyalakan stream permanen atau mengklaim seluruh jaringan terlihat. Maksimum session 30 menit.
    Stop sebelum session diklaim runner harus langsung menjadi terminal. Session
    `running` memperbarui lease lewat snapshot live; runner heartbeat, claim, dan
    API user wajib merekonsiliasi session `running`/`stopping` yang kehilangan
    lease. Jangan melewati lock session yang lease-nya masih segar.
15. **Traffic wajib header-only dan hospital-privacy safe.** Jangan kumpulkan payload, PCAP, URL, DNS content, hostname, credential, cookie, token, atau content aplikasi/pasien.
16. **Traffic diagregasi lokal dan dikirim batch.** Satu packet bukan satu row/function call; live state bounded dan dioverwrite. Flow directional dan conversation normalized adalah konsep terpisah.
17. **Start/stop Traffic admin-only.** Viewer approved read-only. Browser hanya mengirim duration allow-listed; interface/capture expression tidak boleh berasal dari browser.
18. **Label hop adalah lookup manual, bukan topology discovery.** Simpan identitas
    responding Layer-3 IP satu kali di `network_nodes` dan resolve berdasarkan
    `hop_ip` saat render. Jangan copy label ke `hop_measurements`, jangan menebak
    nama/lokasi/perangkat, dan jangan mengklaim switch Layer-2 yang tidak muncul
    sebagai responding hop. Approved viewer hanya baca; mutation admin-only via RLS.
19. **Network Discovery aktif hanya on-demand dan admin-only.** Discovery bukan bagian
    Health Watch atau Traffic. Browser hanya memilih runner; subnet harus berasal dari
    default physical IPv4 route Windows dan divalidasi ulang runner. MVP hanya menerima
    `/24` sampai `/30`, concurrency ICMP maksimal 4, timeout 400 ms, neighbor cache +
    satu ICMP per host, tanpa port/service/OS/vulnerability scan. Hasil memakai satu row
    sementara per runner yang dioverwrite dan dibersihkan setelah expiry; jangan membuat
    `network_nodes` atau `network_targets` tanpa action admin eksplisit.

20. **Quick Device Inspector adalah single-target, bounded, admin-only.** Target harus berasal dari hasil Discovery aktif atau `network_nodes`, lalu divalidasi ulang runner. Browser tidak boleh mengirim command, CIDR, URI, port list, Nmap flags/NSE, atau script. Gunakan fixed TCP 22/80/443/445/554/631/1883/8080/8443/9100, SSDP unicast UDP/1900, serta NetBIOS Node Status UDP/137 hanya ketika SMB/445 terbuka; concurrency maksimal 4 dan total timeout 30 detik. HTTP/HTTPS tidak mengikuti redirect dan UPnP LOCATION wajib kembali ke target yang sama. Simpan hanya fingerprint normalized; jangan simpan raw stdout/HTML/XML/body/payload/secrets. MAC target hanya untuk same-subnet; routed target wajib MAC `null`. Detected identity tidak boleh menimpa operator identity atau membuat alert/severity event.

21. **Managed Infrastructure Telemetry adalah SNMP read-only untuk target allow-listed.** Hanya perangkat yang sudah ada di `network_nodes` yang boleh dijadikan target. Admin menambahkan target di `/admin#managed-telemetry` dan hanya memilih **nama credential profile** lokal runner (`monitoring-readonly`/`core-readonly`); jangan terima atau masukkan community string, username, atau password SNMP di form, browser, Supabase, atau log. Runner melakukan polling bounded SNMPv2c/v3 read-only dengan OID tetap dan terbatas (identitas sistem, uptime, interface, octet counters, error/discard); tanpa walk bebas, credential guessing, SNMP SET, LLDP/CDP, topology mapping, atau deep scan. Hanya simpan latest-state (satu `managed_device_latest` + satu row per `managed_interface_latest`) dan event transisi saat threshold terlampaui; jangan membuat row per poll. Browser hanya `select`; write latest lewat service-role runner endpoint dan config lewat admin action, dengan RLS approved-read.

## Konvensi coding per komponen

### `/agent` (Python)
- Gunakan `scapy` atau `pyshark` untuk capture, `psutil` untuk statistik interface.
- Interval default agregasi: 10 detik, taruh sebagai konstanta yang gampang diubah.
- Semua request ke Supabase pakai REST API (`supabase-py` atau `requests`), dengan retry + exponential backoff.
- Jangan hardcode kredensial — pakai `.env`.
- Bandwidth/path diagnostics (`iperf3`, `mtr`) dipanggil lewat `subprocess`, bukan library binding — parse output `-J`/`--json`, jangan parse teks biasa. Default interval jauh lebih jarang dari metrik utama (lihat `AGENT_SETUP.md`), dan bisa dipicu manual lewat command terpisah.
- `iperf3` butuh server (`iperf3 -s`) jalan di titik target — ini dependency infrastruktur, dicatat di `AGENT_SETUP.md`, bukan sesuatu yang di-assume otomatis ada.
- Hasil WiFi tetap valid sebagai pengukuran end-to-end, tetapi jangan dipresentasikan sebagai bukti bottleneck wired. MTR hanya memperlihatkan hop Layer 3 yang merespons, bukan setiap switch Layer 2; UI dan laporan hanya boleh menyebut *suspected bottleneck* tanpa memastikan perangkat penyebab tanpa bukti tambahan.
- Command `diagnostic-run` boleh mengeluarkan JSON Lines yang sudah dinormalisasi (`stage`, `interval`, `summary`, `complete`) untuk dikonsumsi runner. Jangan keluarkan raw packet, secret, atau stack trace ke stdout protocol.
- Command `traffic-live` memakai Scapy header-only, aggregate 5-tuple in-memory, snapshot 2 detik, cumulative persistence 10 detik, queue SQLite yang coalescing dan bounded, serta hard timeout 30 menit. ICMP memakai port `null`.
- Command `snmp-telemetry` read-only memakai OID tetap dan terbatas, polling bounded sesuai interval target, dan menormalisasi interface fisik/logis tanpa SNMP SET, walk bebas, LLDP/CDP, atau topology. Sekret profil SNMP hanya di config lokal; jangan kirim community/credential ke Supabase, log, atau stdout protocol.

### `/runner` (Windows)
- Gunakan service credential hanya dari `.env` lokal yang tidak di-commit dan jangan pernah log/return key.
- Preflight wajib memverifikasi distro, project root, persistent agent venv Python >=3.11, executable `network-monitor`, `iperf3`, `mtr`, dan backend config. Jangan fallback ke system Python.
- Panggil `wsl.exe` dengan `subprocess` argument list, `shell=False`, `CREATE_NO_WINDOW`, dan capture stdout/stderr. Hanya parse JSON Lines agent, bukan raw iperf3 JSON.
- Network context memakai fixed `scripts/get-network-context.ps1`, argument hanya
  target/port hasil allow-list lokal, `shell: false`, output JSON tervalidasi.
  Gunakan Windows route lookup; jangan pilih adapter aktif pertama.
- Active bandwidth diagnostic admin-only, explicit click, satu job per runner,
  durasi normal hanya 5/10 detik. Jangan mulai bila TCP iperf3 belum ready.
- Task Scheduler setup harus mendukung install/start/status/remove dan berjalan tersembunyi saat user login.
- Traffic memakai runner/Task Scheduler yang sama. Invocation harus structured, interface dari config lokal, dan hanya child capture milik runner yang boleh dihentikan.
- Network Health Watch memakai scheduler asynchronous terpisah di runner Windows yang sama. Jalankan hanya ICMP ke `network_targets` yang enabled, lewat fixed `PING.EXE` argument list (`shell: false`), bounded timeout, concurrency maksimal 4, dan jangan menghambat heartbeat/job polling.
- Jangan simpan satu row per ping. Pertahankan short window maksimal 5 secara lokal, upsert satu `network_health_latest` per target, dan buat `events.source = network_health` hanya saat transisi status. Queue outage harus coalesced/bounded dan retry memakai backoff.
- Network Discovery memakai fixed `get-discovery-context.ps1` tanpa argumen browser.
  Jalankan hanya ketika structured session admin diklaim, tolak prefix lebih lebar dari
  `/24`, hentikan setelah satu sweep, dan kirim progress maksimal per 32 alamat—bukan
  satu request/row per ping. Discovery tidak memakai WSL, Scapy, iperf3, atau MTR.

- Device Inspector memakai runner yang sama dan structured operation `device_inspect`. Windows helper hanya mengumpulkan route/neighbor serta metadata adapter context; parsing metadata, evidence normalization, classifier, dan confidence tetap di agent Python. Jika target sama dengan IPv4 lokal Windows, helper wajib menandai `This Device` dan menentukan physical/virtual dari metadata adapter—bukan range IP atau nama interface WSL. Konflik dengan kategori operator hanya warning dan tidak boleh memutasi identity, Health target, event, atau severity. Optional probe failure menghasilkan partial profile, bukan menggagalkan seluruh inspection.
- SNMP telemetry memakai scheduler terpisah di runner yang sama, independen dari capture/Health Watch/Discovery/Diagnostics. Polling hanya ke `managed_telemetry_targets` yang enabled dengan interval configurable, concurrency kecil, timeout pendek, dan profile credential di-resolve dari config lokal runner—bukan dari Supabase. Simpan counter cache lokal untuk menghitung rate/utilisasi antar-poll; upsert satu `managed_device_latest` + satu `managed_interface_latest` per interface, dan buat `events.source = managed_telemetry` hanya saat transisi. Jangan pernah menulis secret ke Supabase/log dan jangan publish per-poll ke browser.
- Fingerprint enrichment hanya boleh membaca header/title HTTP terbatas, metadata sertifikat TLS, deskripsi UPnP same-target, dan optional hostname NetBIOS. Jangan browse share, user, file, mDNS daemon, SNMP, LLDP, atau menganggap timeout TCP sebagai bukti port difilter.
- Capability Device Inspector wajib diperiksa dari executable project melalui
  `network-monitor capabilities` saat startup runner dan disimpan ringkas di
  `diagnostic_runners.capabilities`. Engine MVP adalah Python socket; Nmap/curl yang
  terpasang tidak boleh diam-diam dijadikan dependency atau dipanggil tanpa perubahan
  requirement. Tool opsional yang hilang tidak boleh membuat seluruh runner offline.

### `/frontend` (Next.js)
- Gunakan App Router.
- Auth & data fetching pakai `@supabase/supabase-js`, subscribe Realtime untuk update live (dashboard, alert).
- Halaman: `/dashboard`, `/traffic`, `/history`, `/alerts`, `/diagnostics`, `/admin` (khusus role admin, proteksi di middleware + RLS).
- State server-driven sebisa mungkin (Server Components), client component hanya untuk bagian interaktif (filter, realtime subscription).
- `/traffic` memakai satu subscription snapshot per halaman, filter snapshot di browser, tabel desktop/card mobile, dan selalu menampilkan capture scope `This Device`.
- Dashboard adalah permukaan utama Network Health Watch dan memakai satu channel
  Realtime untuk health target/event. Ringkasan Traffic memakai snapshot pasif; drawer
  discovery boleh membuka satu channel sementara untuk session/results. Detail harus
  menjelaskan keterbatasan ICMP; link diagnostics tidak boleh auto-run. Admin mengelola
  identitas/promosi dari `network_nodes`, bukan input subnet/arbitrary host.

- Device Profile harus satu reusable drawer untuk Discovery, Health Watch, Traffic, dan LAN Diagnostic hops. Approved viewer hanya membaca saved profile; admin dapat Inspect, Inspect again, Save identity/fingerprint, dan Add to Health Watch secara eksplisit. Target yang sudah enabled di Health Watch tidak boleh ditawari Add lagi; tampilkan status/link Health. Traffic dan MTR tidak boleh otomatis memicu active inspection.
- Device Profile menampilkan bagian Managed Infrastructure Telemetry: status koneksi target, identitas sistem/uptime, dan tabel interface dengan utilisasi/error/discard plus peringatan per interface. Pakai satu subscription Realtime untuk latest-state (state berubah tanpa refresh). Tampilkan status credential profile (`available`/`missing`) tanpa pernah menampilkan nilai secret. Admin mengelola target di `/admin#managed-telemetry`; approved viewer read-only. Nilai SNMP hanyalah snapshot, bukan bukti perangkat rusak.

### `/hermes-agent` (Flask)
- Endpoint utama: `POST /analyze` — terima `event_id`, ambil context dari Supabase, panggil LLM, tulis balik `ai_summary`.
- Karena HF Spaces free tier bisa sleep, desain endpoint idempotent dan tahan cold start.

### `/supabase`
- Semua perubahan schema lewat file migration SQL, jangan ubah manual dari dashboard tanpa dicatat.
- RLS policy ditulis eksplisit per tabel, jangan andalkan default.
- `network_targets` approved-read/admin-write; `network_health_latest` approved-read dan service-role-write. Health event tidak boleh masuk ke baseline/severity `ingest` traffic.
- `network_discovery_sessions` admin-read dan service-role-write. Tepat satu slot per
  runner; results bounded JSON sementara, bukan inventory/history, dan wajib expired.

- `device_inspection_sessions` admin-read dan service-role-write; satu slot per runner, result maksimal 64 KiB dan expired 10 menit. `network_nodes.detected_fingerprint` maksimal 32 KiB, normalized, dan tidak memuat raw tool response.
- `managed_telemetry_targets` approved-read/admin-write (config via admin action) dan hanya menyimpan `credential_profile` sebagai nama profil lokal runner—tanpa secret. `managed_device_latest` dan `managed_interface_latest` approved-read dan service-role-write, tepat satu row latest per target/interface. Event `source = managed_telemetry` terpisah dari baseline `ingest` traffic dan dari Health Watch.

## Definisi severity (jangan diubah tanpa approval Raka)

| Severity | Kondisi |
|---|---|
| low | Fluktuasi kecil, masih baseline normal |
| medium | Traffic > 1.5x baseline jam yang sama, atau latency naik signifikan |
| high | Packet loss signifikan, throughput drop tajam |
| critical | Gateway/DNS unreachable (not internet), atau anomali ekstrem |

## Yang TIDAK boleh dilakukan AI assistant

- Jangan mengubah Device Inspector menjadi deep/full-port/vulnerability scan, SNMP, credential guessing, topology discovery, atau Internet scanner. Satu-satunya jalur SNMP adalah workflow read-only Managed Infrastructure Telemetry (rule 21) untuk target allow-listed; Device Inspector tetap tidak memanggil SNMP/LLDP.

- Jangan sarankan menyimpan raw pcap di Postgres/Supabase Storage sebagai default behavior.
- Jangan bikin fitur capture paket berjalan di serverless/cloud — itu tidak mungkin secara teknis (butuh akses NIC lokal).
- Jangan tambahkan dependency berbayar/service non-free tanpa mengonfirmasi ke Raka dulu (goal-nya semua gratis: Vercel, Supabase, HF Spaces).
- Jangan jalankan `iperf3`/`mtr` secara kontinu tiap beberapa detik seperti metrik utama, dan jangan campurkan hasilnya ke perhitungan baseline/severity di edge function `ingest`.
- Jangan menjalankan subnet scan otomatis/berulang, menerima arbitrary CIDR dari
  browser, auto-promote hasil discovery, menambah SNMP credential, atau menyimpulkan
  topology/perangkat mati. Satu-satunya pengecualian discovery adalah sweep ringan
  admin-only pada subnet Windows `/24`–`/30` yang diatur rule 19. SNMP juga hanya
  read-only polling target terkelola yang diatur rule 21—tanpa scanning luas,
  credential guessing, SNMP SET, LLDP/CDP, atau topology inference.
