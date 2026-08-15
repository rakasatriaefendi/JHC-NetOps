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

### `/hermes-agent` (Flask)
- Endpoint utama: `POST /analyze` — terima `event_id`, ambil context dari Supabase, panggil LLM, tulis balik `ai_summary`.
- Karena HF Spaces free tier bisa sleep, desain endpoint idempotent dan tahan cold start.

### `/supabase`
- Semua perubahan schema lewat file migration SQL, jangan ubah manual dari dashboard tanpa dicatat.
- RLS policy ditulis eksplisit per tabel, jangan andalkan default.
- `network_targets` approved-read/admin-write; `network_health_latest` approved-read dan service-role-write. Health event tidak boleh masuk ke baseline/severity `ingest` traffic.
- `network_discovery_sessions` admin-read dan service-role-write. Tepat satu slot per
  runner; results bounded JSON sementara, bukan inventory/history, dan wajib expired.

## Definisi severity (jangan diubah tanpa approval Raka)

| Severity | Kondisi |
|---|---|
| low | Fluktuasi kecil, masih baseline normal |
| medium | Traffic > 1.5x baseline jam yang sama, atau latency naik signifikan |
| high | Packet loss signifikan, throughput drop tajam |
| critical | Gateway/DNS unreachable (not internet), atau anomali ekstrem |

## Yang TIDAK boleh dilakukan AI assistant

- Jangan sarankan menyimpan raw pcap di Postgres/Supabase Storage sebagai default behavior.
- Jangan bikin fitur capture paket berjalan di serverless/cloud — itu tidak mungkin secara teknis (butuh akses NIC lokal).
- Jangan tambahkan dependency berbayar/service non-free tanpa mengonfirmasi ke Raka dulu (goal-nya semua gratis: Vercel, Supabase, HF Spaces).
- Jangan jalankan `iperf3`/`mtr` secara kontinu tiap beberapa detik seperti metrik utama, dan jangan campurkan hasilnya ke perhitungan baseline/severity di edge function `ingest`.
- Jangan menjalankan subnet scan otomatis/berulang, menerima arbitrary CIDR dari
  browser, auto-promote hasil discovery, menambah SNMP credential, atau menyimpulkan
  topology/perangkat mati. Satu-satunya pengecualian discovery adalah sweep ringan
  admin-only pada subnet Windows `/24`–`/30` yang diatur rule 19.
