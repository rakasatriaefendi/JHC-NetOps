# DESIGN.md — Design system

Dokumen ini adalah sumber kebenaran untuk token visual project **Network Traffic Monitoring Dashboard**. Dipakai untuk menyamakan hasil desain di Google Stitch/Figma dengan implementasi kode di Next.js (Tailwind config, dsb). Kalau ada perbedaan antara file `.fig` dan dokumen ini, dokumen ini yang jadi acuan final kecuali didiskusikan ulang.

## Prinsip desain

- Tools fungsional untuk dipantau berjam-jam, bukan landing page. Prioritaskan kejelasan & kenyamanan mata di atas dekorasi.
- Hindari gaya "AI slop": tanpa glassmorphism, neumorphism, glow/neon, gradient ungu-biru, drop shadow berlebihan, bentuk blob 3D mengambang.
- Referensi: Linear, Vercel dashboard, Grafana, Datadog.

## Tipografi

| Peran | Font | Catatan |
|---|---|---|
| UI (nav, label, heading, body) | **Inter** | 400 body, 500 label/subheading, 600 heading saja |
| Data (IP, port, timestamp, angka metrik) | **JetBrains Mono** (alternatif: IBM Plex Mono) | Dipakai konsisten untuk semua kolom numerik/teknis |

Type scale — jangan keluar dari skala ini:
- 12px — meta/secondary text
- 14px — body & default isi tabel
- 16px — section label
- 20-22px — page heading

## Warna — dark theme (tema utama)

| Token | Hex | Pemakaian |
|---|---|---|
| `bg-base` | `#14171C` | Background halaman |
| `bg-surface` | `#1C2027` | Card, panel, sidebar |
| `border` | `#2A2F38` | Garis pemisah, border input |
| `text-primary` | `#E4E6EA` | Teks utama |
| `text-secondary` | `#9AA1AC` | Label, teks sekunder |
| `text-muted` | `#6B7280` | Hint, timestamp kecil |
| `accent` | `#3E9C8A` | Link, tombol utama, elemen interaktif |

## Warna — light theme (alternatif)

| Token | Hex | Pemakaian |
|---|---|---|
| `bg-base` | `#F5F4F0` | Background halaman (warm off-white, bukan putih polos) |
| `bg-surface` | `#FFFFFF` | Card, panel |
| `border` | `#E2E0DA` | Garis pemisah |
| `text-primary` | `#1F2328` | Teks utama |
| `text-secondary` | `#5B6169` | Label, teks sekunder |
| `accent` | `#0F6E56` | Link, tombol utama |

## Warna status/severity (dipakai sama di kedua tema, disesuaikan opacity)

| Severity | Hex (dark bg) | Karakter warna |
|---|---|---|
| Normal / Low | `#4C9A6A` | Hijau redup, bukan hijau terang |
| Medium | `#C79A45` | Amber redup |
| High | `#C67C4E` | Oranye kecoklatan |
| Critical | `#B0524A` | Merah tua redup |

Aturan wajib: warna status **selalu dipasangkan dengan icon + label teks**, tidak pernah mengandalkan warna saja (aksesibilitas & konsistensi dengan colorblind user).

## Spacing

Grid dasar 4px. Skala yang dipakai: `4, 8, 12, 16, 24, 32, 48` (px). Jangan pakai angka di luar skala ini untuk padding/margin/gap.

## Radius

- Input, button, badge: `6px`
- Card, panel, modal: `12px`
- Tidak ada elemen dengan radius besar (pill) kecuali badge status.

## Komponen inti (harus reusable, sama persis di semua halaman)

- **Nav item** — sidebar (desktop) / drawer item (mobile), state default/hover/active.
- **Status badge** — pill kecil, warna severity + icon + label singkat.
- **Metric card** — untuk ringkasan Dashboard (throughput, latency, packet loss).
- **Table row** — desktop: baris tabel biasa. Mobile: berubah jadi card ringkas (lihat breakpoint di bawah).
- **Filter chip / dropdown** — untuk filter Traffic & History.
- **Button** — flat, border 1px, tanpa shadow mengambang. Varian: primary (`accent`), secondary (outline), destructive (severity high/critical color).
- **Input/search bar** — flat, border 1px, focus state pakai `accent` sebagai outline tipis.
- **Bandwidth chart** — line chart sederhana (bitrate over time per titik uji), angka pakai JetBrains Mono, warna garis pakai `accent`, bukan warna severity (ini data diagnostik, bukan status).
- **Hop latency table** — baris per hop (nomor hop, IP, avg latency, loss %), angka pakai JetBrains Mono. Hop dengan latency yang naik tajam dibanding hop sebelumnya boleh ditandai pakai warna severity `Medium`/`High` sebagai highlight visual, tetap dengan icon + label, bukan warna saja.
- **Labeled path sequence** — presentasikan SOURCE → responding hops → TARGET
  secara vertikal dan tetap urut menurut `hop_number`. IP/latency/loss memakai
  JetBrains Mono; identity memakai label inventory atau `Unknown node`. Admin
  mendapat action kecil `+ Beri nama`/`Edit node` pada hop, viewer read-only.
  Editor tetap flat, memakai input/button token yang ada, dan tidak mengklaim
  label sebagai topology discovery atau bukti perangkat Layer-2 yang dilalui.
- **Runner health card** — status `Online`, `Offline`, atau `Setup issue` selalu memakai icon + label. Error menampilkan safe code dan tindakan singkat, bukan stack trace.
- **Diagnostic stage list** — urutan preparing runner, validating allow-listed target, starting WSL, upload, download, MTR, saving, complete. Stage aktif memakai `accent`; failure memakai icon + label severity, bukan warna saja.
- **Live throughput chart** — satu series untuk stage upload/download yang sedang berjalan, angka JetBrains Mono dan garis `accent`. Sample bersifat sementara dan graph tidak boleh menyiratkan localhost sebagai performa LAN.
- **Test environment banner** — panel bordered yang jelas bertuliskan `TEST ENVIRONMENT · Localhost simulation · Not valid for LAN bottleneck analysis`; jangan hanya mengandalkan warna.
- **Diagnostic result card** — tampilkan upload dan download terpisah, context source/target/connection/duration, ringkasan path, timestamp, serta bahasa `suspected bottleneck` tanpa klaim root cause perangkat.
- **Current Network card** — tampilkan adapter route Windows, actual connection,
  IPv4/prefix, subnet, gateway, DNS, dan `Local link speed`; link speed tidak boleh
  diberi label available bandwidth. WiFi boleh menampilkan SSID/signal jika tersedia.
- **Route to Target card** — pisahkan target resmi dari gateway; tampilkan on-link
  atau routed, source interface/IP, next hop, dan metric memakai font data.
- **Preflight readiness card** — status runner/interface/route/gateway/target/iperf3
  selalu memakai icon + label. `No ICMP response` adalah state netral/peringatan,
  bukan klaim target offline; iperf unavailable menonaktifkan tombol bandwidth.
- **Traffic capture card** — tampilkan Runner, Capture, scope `This Device`, started, elapsed, serta admin start/stop. Status selalu icon + label.
- **Observed traffic metrics** — RX/TX wajib disebut `Observed`, tidak boleh disebut available bandwidth. Angka memakai JetBrains Mono.
- **Live Flow Explorer** — desktop table, mobile card. Source/destination tetap directional; inferred service selalu diberi label `inferred`.
- **Flow detail** — drawer/panel header-only: endpoint, protocol, inferred service, timestamps, observed rate, peak, bytes, packets, status. Jangan sediakan payload/hex/PCAP.
- **Traffic tabs** — `Live Flows`, `Conversations`, `Top Talkers`; active memakai accent dan struktur flat tanpa dekorasi berlebih.

- **Network health summary** — lima card ringkas: known, online, degraded, offline, dan average latency. Angka memakai JetBrains Mono; status selalu icon + label, tidak mengandalkan warna saja.
- **Known-target table/card** — desktop table dan mobile card terpisah, kelompok critical lebih dahulu. Tampilkan status, identity inventory, IP, lokasi, latency, short-window loss, dan waktu check.
- **Health target detail** — drawer dari kanan berisi metadata, threshold state, last check/success, disclaimer keterbatasan ICMP, dan link eksplisit ke LAN Diagnostics. Link hanya prefill dan tidak auto-run.
- **Health empty state** — jelaskan bahwa tidak ada target enabled dan arahkan admin ke konfigurasi inventory; jangan menampilkan seolah jaringan down.
- **Admin monitoring targets** — form tambah berdiri sendiri dan kembali ke placeholder kosong setelah submit. Target tersimpan tampil sebagai desktop table/mobile cards; form edit hanya dibuka untuk satu target setelah action `Edit`, bukan dirender permanen pada setiap row.
- **Diagnostic latest vs history** — panel active/latest hanya menampilkan progress dan summary sesi terbaru. Detail path lengkap berada di `Riwayat hasil per sesi`, collapsed secara default dan dibuka satu sesi pada satu waktu agar tidak terlihat sebagai data duplikat.
- **Local Traffic summary** — panel pertama Dashboard menampilkan `Observed RX`,
  `Observed TX`, active flows, top talker, dan link `Open Traffic`. RX dijelaskan
  sebagai Receive dan TX sebagai Transmit; helper wajib menyatakan keduanya traffic
  teramati, bukan kapasitas maksimum link. Jika capture berhenti, tampilkan state
  operasional singkat tanpa instruksi deployment developer.
- **Network Discovery drawer** — drawer kanan admin-only, mengikuti panel/radius/token
  existing. Context runner tampil sebelum Start. Progress berupa scanned/total dan found;
  desktop memakai table, mobile card. Bedakan badge `DISCOVERED`, `KNOWN`, `MONITORED`,
  serta `Seen in Traffic` tanpa mengandalkan warna saja. Action nama dan promotion harus
  terpisah; tidak ada tombol utama Select All/Monitor All.

- **Device Profile drawer** — satu drawer kanan reusable dari Discovery, Health Watch, Traffic, dan LAN Diagnostic hops; jangan membuat halaman profile baru. Header memakai operator name bila ada, IP monospace, detected identity, type, confidence berupa icon + label. Pisahkan section `Detected identity`, `Network identity`, `Observed services`, `Identification evidence`, dan `Operator identity`. Inspect membuka drawer segera dan menampilkan stage progress. Action aktif hanya admin; viewer mendapat saved profile read-only. Gunakan kata `Observed services`, bukan menyiratkan seluruh port sudah diuji. Tampilkan keterbatasan routed MAC, unmanaged Layer-2 switch, dan MTR Layer-3 secara ringkas tanpa mengandalkan warna.

## Breakpoint & perilaku mobile

- Breakpoint utama: `768px`.
- Di bawah breakpoint: sidebar desktop → hamburger + drawer slide-in dari kiri (style identik dengan sidebar, cuma beda posisi).
- Tabel (Traffic, History) → card-per-row, bukan scroll horizontal maupun font diperkecil.
- Filter row → collapsible panel lewat icon filter.
- Summary cards Dashboard → stack 1 kolom.

## Catatan implementasi

- Kalau dipakai di Tailwind config, jadikan token di atas sebagai `theme.extend.colors` dan `theme.extend.fontFamily`, jangan hardcode hex langsung di komponen.
- File `.fig` hasil export Google Stitch tetap harus dicek ulang terhadap tabel warna & tipografi di dokumen ini sebelum dijadikan acuan build — AI design tool kadang sedikit meleset dari instruksi persis.
