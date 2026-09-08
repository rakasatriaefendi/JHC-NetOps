# 1. RINGKASAN SISTEM

JHC NetOps Monitor adalah aplikasi internal untuk visibilitas, pemantauan, dan troubleshooting jaringan. Aplikasi menggabungkan inventaris perangkat, Health Watch berbasis ICMP, Traffic Live pada perangkat runner, Network Discovery on-demand, LAN Diagnostics, Managed Telemetry berbasis SNMP read-only, Observed LAN Hosts, riwayat, alert, serta administrasi akses pengguna.

Manual Book ditulis oleh **Raka Satria Efendi**. Pengembangan sistem dan dokumentasi menerima arahan, masukan, dan dukungan dari **Tim Teknologi Informasi Rumah Sakit Jantung Jakarta**.

Model penggunaan yang terverifikasi dari source:

- Seluruh halaman operasional memerlukan akun dengan status `approved` (ditampilkan sebagai Aktif). Akun pending/rejected diarahkan ke halaman status akun.
- Viewer dapat membaca halaman operasional. Operator dan Admin dapat menjalankan aksi jaringan serta mengelola Device, Health Watch, dan Managed SNMP Target. Hanya Admin dapat membuka menu Admin dan User Access Control.
- Dashboard adalah ringkasan; Traffic, History, Alerts, Devices, SNMP, dan LAN Diagnostics mempunyai workspace masing-masing.
- Operasi aktif tidak menerima alamat atau command bebas dari browser. Target berasal dari inventory/konfigurasi yang diizinkan.
- Aplikasi mendukung tepat dua bahasa: Indonesia dan English. Default Indonesia, fallback English.
- Nilai kosong pada UI yang telah diaudit menggunakan `-`; data teknis runtime tidak diterjemahkan.

Jumlah fitur besar yang diaudit: **13**. Audit ini memprioritaskan implementasi source saat ini; perbedaan dengan dokumen lama diselesaikan mengikuti source.

# 2. INVENTARIS FITUR

| No. | Fitur | Route/entry point | Ringkasan kemampuan saat ini |
|---:|---|---|---|
| 1 | Authentication | `/login`, `/register`, `/pending` | Login, registrasi, status menunggu/ditolak, logout, validasi input. |
| 2 | Application Shell & Language | Semua halaman protected | Sidebar/mobile drawer, user dan role, active navigation, Indonesia/English. |
| 3 | Dashboard | `/dashboard` | Traffic summary, Network Health, Health Trends, Reachability Map, event terbaru, Discovery, diagnostics summary. |
| 4 | Network Health & Manual Ping | Dashboard dan Devices | Status online/degraded/offline, latency/loss, Manual Ping ephemeral, konfigurasi ICMP terjadwal. |
| 5 | Network Discovery | Dashboard → Discover | Discovery bounded dan on-demand melalui runner; hasil tidak otomatis menjadi inventory. |
| 6 | Traffic Live | `/traffic` | Capture header-only pada This Device, RX/TX, packet rate, flow/conversation/talker, filter dan detail. |
| 7 | History | `/history` | Tab Network Health Events dan Diagnostic History; filter, trend, tabel sesi, detail path. |
| 8 | Alerts | `/alerts` | Alert Network Health aktif yang belum resolved, severity, waktu, judul, deskripsi. |
| 9 | Devices & Device Profile | `/devices` dan drawer reusable | Inventory manual, edit/delete, Health Watch, detected identity, bounded Device Inspector, Managed Telemetry snapshot. |
| 10 | Managed SNMP Telemetry | `/snmp` | Target SNMP known-device, status, identity system, interface, polling, profile reference, thresholds. |
| 11 | Observed LAN Hosts | `/snmp/[targetId]/hosts` | Neighbor evidence, search, filter, sort Device/IP, current/stale, optional NetBIOS. |
| 12 | LAN Diagnostics | `/diagnostics` | Preflight, upload/download iperf3, MTR path, latency/loss, hasil dan interpretasi. |
| 13 | Admin | `/admin` | User Access Control: role dan status akses, khusus Admin. |

# 3. MATRIKS ROLE DAN HAK AKSES

Semua izin berikut tetap mensyaratkan status profil **Aktif/approved**. Role tanpa status approved tidak memperoleh izin operasional.

| Fitur | Admin | Operator | Viewer | Evidence / Notes |
|---|---|---|---|---|
| Dashboard | Lihat + aksi | Lihat + aksi | Lihat | Protected route; aksi jaringan memakai `canOperateNetwork`. |
| Traffic | Lihat, start/stop | Lihat, start/stop | Lihat saja | Tombol capture hanya untuk role operasional. |
| History | Lihat | Lihat | Lihat | Protected approved-user route. |
| Alerts | Lihat | Lihat | Lihat | Protected approved-user route; halaman tidak menyediakan mutasi alert. |
| Devices | Lihat + kelola | Lihat + kelola | Lihat | `canManage=canOperateNetwork(role)`. |
| Add Device | Ya | Ya | Tidak | Server action memakai `requireOperatorProfile`. |
| Edit Device | Ya | Ya | Tidak | Kontrol disembunyikan dari Viewer; server tetap memvalidasi role. |
| Delete Device | Ya | Ya | Tidak | Konfirmasi dan dependency check server-side. |
| Health Watch | Lihat | Lihat | Lihat | Snapshot/status dapat dibaca approved user. |
| Health Watch management | Ya | Ya | Tidak | Create/update/delete melalui action operator. |
| Manual Ping | Ya | Ya | Tidak | Dashboard menerima `isAdmin` dari `canOperateNetwork`; target/capability harus tersedia. |
| Network Discovery | Ya | Ya | Tidak | Tombol/drawer hanya role operasional; on-demand. |
| Device Inspector aktif | Ya | Ya | Tidak | Viewer hanya membuka profile tersimpan. |
| SNMP | Lihat + kelola | Lihat + kelola | Lihat | Target form/action hanya role operasional. |
| Add/Edit/Delete SNMP Target | Ya | Ya | Tidak | Action memakai `requireOperatorProfile`. |
| Observed LAN Hosts | Lihat | Lihat | Lihat | Workspace read-only bagi seluruh approved user. |
| LAN Diagnostics | Lihat + jalankan | Lihat + jalankan | Lihat hasil | Viewer mendapat notice bahwa Operator diperlukan untuk tes aktif. |
| Admin | Ya | Tidak | Tidak | `requireAdminProfile`; non-Admin diarahkan ke Dashboard. |
| User Access Control | Ya | Tidak | Tidak | Hanya Admin; akun sendiri tidak dapat diubah dari form tersebut. |

# 4. PANDUAN CEPAT / QUICK GUIDE

## QG-01 Cara login

- **Tujuan:** masuk ke aplikasi.
- **Role/access:** akun terdaftar; akses fitur setelah status approved.
- **Halaman awal:** `/login`.
- **Jalur menu:** buka NetOps Monitor → Login.
- **Urutan:** isi email → isi password → klik Login.
- **Input:** email dan password wajib.
- **Hasil:** akun approved menuju Dashboard; status lain diselesaikan melalui alur `/auth/resolve` dan `/pending`.
- **Catatan:** pesan kredensial salah dibuat generik; password tidak ditampilkan.
- **Screenshot:** SHOT-001.
- **Callout:** 1 email, 2 password, 3 tombol Login, 4 link Register.

## QG-02 Cara logout

- **Tujuan:** mengakhiri sesi.
- **Role/access:** pengguna yang sudah login.
- **Halaman awal:** halaman protected mana pun.
- **Jalur menu:** sidebar → area akun.
- **Urutan:** klik Sign out/Keluar.
- **Input:** tidak ada.
- **Hasil:** diarahkan ke `/login`.
- **Catatan:** pada mobile buka tombol menu terlebih dahulu.
- **Screenshot:** SHOT-002.
- **Callout:** 1 nama pengguna, 2 role, 3 tombol logout.

## QG-03 Cara mengganti bahasa Indonesia / English

- **Tujuan:** mengganti bahasa UI.
- **Role/access:** pengguna approved.
- **Halaman awal:** halaman protected mana pun.
- **Jalur menu:** sidebar → Language/Bahasa.
- **Urutan:** buka selector → pilih Indonesia atau English.
- **Input:** salah satu dari dua bahasa.
- **Hasil:** UI client dan server-rendered diperbarui; pilihan bertahan setelah refresh.
- **Catatan:** IP, MAC, hostname, model, OID, protocol, dan measured value tidak diterjemahkan.
- **Screenshot:** SHOT-003.
- **Callout:** 1 label Bahasa, 2 pilihan Indonesia, 3 pilihan English.

## QG-04 Cara melihat kondisi jaringan saat ini

- **Tujuan:** memperoleh ringkasan kondisi jaringan.
- **Role/access:** semua approved user.
- **Halaman awal:** `/dashboard`.
- **Jalur menu:** Dashboard.
- **Urutan:** periksa Traffic summary → Network Health → Health Trends → Reachability → event/diagnostics summary.
- **Input:** tidak ada.
- **Hasil:** ringkasan target, status, latency rata-rata, traffic lokal, dan event terkini.
- **Catatan:** Dashboard adalah ringkasan; buka workspace khusus untuk detail.
- **Screenshot:** SHOT-004.
- **Callout:** 1 Traffic, 2 Network Health, 3 Trends, 4 Reachability, 5 event.

## QG-05 Cara mengecek perangkat online/offline

- **Tujuan:** membaca status Health Watch target.
- **Role/access:** semua approved user.
- **Halaman awal:** Dashboard.
- **Jalur menu:** Dashboard → Network Health.
- **Urutan:** temukan target pada tabel → baca badge online/degraded/offline → klik row untuk detail.
- **Input:** tidak ada.
- **Hasil:** detail latency, loss, last check/success, failure count, interval.
- **Catatan:** tidak adanya ICMP tidak otomatis membuktikan host mati; firewall dapat memblokir ping.
- **Screenshot:** SHOT-005.
- **Callout:** 1 status, 2 latency, 3 loss, 4 last checked, 5 detail row.

## QG-06 Cara menambahkan perangkat ke Device Inventory

- **Tujuan:** menyimpan satu host sebagai inventory.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** `/devices`.
- **Jalur menu:** Devices → Add device manually.
- **Urutan:** isi IPv4 → nama → opsi tipe/lokasi/catatan → klik Add device.
- **Input:** IPv4 dan nama wajib; tipe, lokasi, catatan opsional. IP hanya satu host IPv4, bukan CIDR/range.
- **Hasil:** row muncul pada daftar inventory; duplicate IP memakai row existing tanpa overwrite identity.
- **Catatan:** menyimpan Device tidak menjalankan Discovery, ping, atau SNMP.
- **Screenshot:** SHOT-007 dan SHOT-008.
- **Callout:** 1 IPv4, 2 nama, 3 tipe, 4 lokasi, 5 catatan, 6 submit.

## QG-07 Cara mengaktifkan Health Watch

- **Tujuan:** memantau perangkat secara ICMP terjadwal.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** Devices.
- **Jalur menu:** Devices → row Device → Configure/Kelola Health Watch.
- **Urutan:** pilih runner → isi interval/timeout/threshold → centang Enabled → opsional Critical → Add target.
- **Input:** runner, interval 15–3600 detik, timeout 250–5000 ms, failure 2–10, recovery 1–5, latency 1–60000 ms, loss 0–100%.
- **Hasil:** konfigurasi Health Watch tersimpan dan status muncul pada inventory/Dashboard setelah pengukuran.
- **Catatan:** probe method tetap ICMP; tidak mengaktifkan SNMP.
- **Screenshot:** SHOT-009.
- **Callout:** 1 runner, 2 interval, 3 timeout, 4 thresholds, 5 Enabled, 6 Critical, 7 Add.

## QG-08 Cara mengelola Health Watch

- **Tujuan:** mengubah konfigurasi monitoring.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** Devices.
- **Jalur menu:** Devices → Kelola Health Watch → Edit.
- **Urutan:** klik Edit → ubah nilai/Enabled/Critical → Save changes.
- **Input:** nilai bounded yang sama dengan QG-07; runner tidak dapat diubah pada target existing.
- **Hasil:** row target diperbarui.
- **Catatan:** uncheck Enabled menonaktifkan polling, tetapi konfigurasi masih ada.
- **Screenshot:** SHOT-010.
- **Callout:** 1 Edit, 2 status target, 3 field config, 4 Save changes.

## QG-09 Cara menonaktifkan atau menghapus konfigurasi Health Watch

- **Tujuan:** menghentikan atau melepaskan Health Watch.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** Devices.
- **Jalur menu:** Devices → Kelola Health Watch.
- **Urutan:** untuk pause, Edit → uncheck Enabled → Save; untuk lepas dependency, klik Remove Health Watch → konfirmasi.
- **Input:** konfirmasi target pada dialog untuk remove.
- **Hasil:** disable mempertahankan row; remove menghapus konfigurasi Health Watch saja dan Device tetap ada.
- **Catatan:** agar Device dapat dihapus, konfigurasi harus **Remove**, bukan hanya disabled.
- **Screenshot:** SHOT-011.
- **Callout:** 1 Enabled, 2 Remove Health Watch, 3 dialog konfirmasi.

## QG-10 Cara menghapus perangkat dengan urutan yang benar

- **Tujuan:** menghapus Device Inventory tanpa dependency.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** Devices.
- **Jalur menu:** Devices → Kelola Health Watch dan/atau SNMP → kembali Devices → Delete device.
- **Urutan:** Remove Health Watch jika ada → Delete Managed SNMP Target jika ada → kembali ke Devices → Delete device → konfirmasi.
- **Input:** dialog konfirmasi memakai nama dan IP.
- **Hasil:** Device dihapus setelah tidak direferensikan konfigurasi Health/SNMP.
- **Catatan:** jika dependency masih ada, UI menampilkan instruksi untuk menghapus Health Watch, Managed SNMP, atau keduanya terlebih dahulu.
- **Screenshot:** SHOT-012 dan SHOT-013.
- **Callout:** 1 warning dependency, 2 Kelola Health Watch, 3 menu SNMP, 4 Delete device.

## QG-11 Cara melakukan Network Discovery / scan

- **Tujuan:** menemukan host yang terlihat dari jaringan runner saat ini.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** Dashboard.
- **Jalur menu:** Dashboard → Discover devices.
- **Urutan:** buka drawer → pilih runner → start Discovery → tunggu progress → pilih Inspect/Name/Add to Health Watch sesuai hasil.
- **Input:** runner; tidak ada input CIDR/IP bebas.
- **Hasil:** hasil sementara menampilkan IP/evidence serta status inventory/monitoring.
- **Catatan:** bounded on-demand discovery, bukan continuous scan, port scan, vulnerability scan, atau topology discovery; hasil tidak otomatis menjadi inventory.
- **Screenshot:** SHOT-006.
- **Callout:** 1 runner, 2 subnet/scope, 3 Start, 4 progress, 5 result actions, 6 safety notice.

## QG-12 Cara menjalankan LAN Diagnostics

- **Tujuan:** menguji bandwidth dua arah dan path Layer-3.
- **Role/access:** Admin atau Operator menjalankan; Viewer hanya membaca hasil.
- **Halaman awal:** `/diagnostics`.
- **Jalur menu:** LAN Diagnostics.
- **Urutan:** isi label lokasi sumber → pilih target resmi → pilih durasi → tunggu preflight → klik Run diagnostic.
- **Input:** label lokasi, target allow-listed, durasi yang disediakan UI.
- **Hasil:** upload/download, peak/minimum/retransmit, responding hops, latency/loss, dan interpretasi tersimpan.
- **Catatan:** iperf3 menghasilkan traffic aktif; MTR tidak menunjukkan seluruh perangkat Layer-2; target/iperf3 dapat unavailable.
- **Screenshot:** SHOT-027 dan SHOT-028.
- **Callout:** 1 source, 2 target, 3 duration, 4 preflight, 5 Run, 6 results.

## QG-13 Cara melihat Traffic Live

- **Tujuan:** melihat traffic header-only pada interface runner.
- **Role/access:** semua approved user melihat; Admin/Operator start/stop.
- **Halaman awal:** `/traffic`.
- **Jalur menu:** Traffic.
- **Urutan:** pilih runner/durasi → Start capture → lihat RX/TX, packet rate, flows/conversations/talkers → Stop bila perlu.
- **Input:** runner dan durasi allow-listed; tidak ada packet filter bebas.
- **Hasil:** snapshot live dan flow metadata; aksi otomatis berhenti maksimal 30 menit.
- **Catatan:** scope hanya This Device, bukan seluruh LAN; payload, content, PCAP, URL, credential tidak disimpan.
- **Screenshot:** SHOT-020.
- **Callout:** 1 scope, 2 runner, 3 duration, 4 Start/Stop, 5 metrics, 6 tabs, 7 filters.

## QG-14 Cara menambahkan target ke monitoring SNMP

- **Tujuan:** mengaktifkan Managed Telemetry read-only pada Device existing.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** `/snmp`.
- **Jalur menu:** SNMP → Managed telemetry configuration → Add target.
- **Urutan:** pilih Inventory node → runner → SNMP version → port → interval → profile reference → thresholds → Enabled → Add.
- **Input:** node dan runner wajib; profile **reference** lokal, bukan credential; interval 30/60 detik; bounded thresholds.
- **Hasil:** target muncul dalam tabel managed devices dan dipoll bila enabled serta profile tersedia.
- **Catatan:** Device Inventory harus dibuat dahulu; menambah Device tidak otomatis mengaktifkan SNMP.
- **Screenshot:** SHOT-015.
- **Callout:** 1 node, 2 runner, 3 version, 4 profile ref, 5 thresholds, 6 Enabled, 7 Add.

## QG-15 Cara memastikan SNMP target aktif/terhubung

- **Tujuan:** memeriksa operasi telemetry.
- **Role/access:** semua approved user.
- **Halaman awal:** SNMP.
- **Jalur menu:** SNMP → latest managed state / managed devices.
- **Urutan:** cari target → baca Enabled/Disabled dan latest status → periksa last poll, system identity, uptime, interface count/table.
- **Input:** tidak ada.
- **Hasil:** status connected/partial/failure category dan snapshot telemetry terbaru.
- **Catatan:** status Enabled hanya konfigurasi; operasional dibuktikan oleh latest status/last poll. Freshness aktual perlu dilihat pada running UI.
- **Screenshot:** SHOT-016 dan SHOT-017.
- **Callout:** 1 config status, 2 latest status, 3 last poll, 4 system identity, 5 interfaces.

## QG-16 Cara menghapus target SNMP

- **Tujuan:** melepas konfigurasi Managed SNMP dari Device.
- **Role/access:** Admin atau Operator.
- **Halaman awal:** SNMP.
- **Jalur menu:** SNMP → Managed devices → Delete.
- **Urutan:** klik Delete pada row target → setujui dialog konfirmasi.
- **Input:** konfirmasi berbasis nama dan IP target.
- **Hasil:** target SNMP dihapus; Device Inventory dan Health Watch tidak dihapus.
- **Catatan:** latest device/interface/observed-host rows terkait target mempunyai cascade database; event historis tidak dihapus eksplisit oleh action. Perlu diverifikasi pada running UI untuk penyajian history setelah delete.
- **Screenshot:** SHOT-018.
- **Callout:** 1 Delete, 2 identitas target, 3 dialog konfirmasi.

## QG-17 Cara membuka Observed LAN Hosts

- **Tujuan:** melihat neighbor evidence yang dilaporkan managed device.
- **Role/access:** semua approved user.
- **Halaman awal:** SNMP.
- **Jalur menu:** pilih target/detail → View Observed LAN Hosts.
- **Urutan:** buka target → klik link Observed LAN Hosts.
- **Input:** tidak ada.
- **Hasil:** workspace host observations untuk target tersebut.
- **Catatan:** evidence Layer-3 bukan bukti koneksi fisik atau switch-port.
- **Screenshot:** SHOT-019.
- **Callout:** 1 summary, 2 link View, 3 context target.

## QG-18 Cara mencari host berdasarkan nama/IP/MAC

- **Tujuan:** mempersempit Observed LAN Hosts.
- **Role/access:** semua approved user.
- **Halaman awal:** Observed LAN Hosts.
- **Jalur menu:** SNMP → target → Observed LAN Hosts.
- **Urutan:** ketik pada Search observed hosts.
- **Input:** inventory name, NetBIOS, IP, atau MAC; pencarian case-insensitive.
- **Hasil:** `Devices: X / Y` berubah sesuai hasil visible.
- **Catatan:** data tetap berasal dari dataset target yang sudah dimuat.
- **Screenshot:** SHOT-019.
- **Callout:** 1 Search, 2 visible/total count, 3 hasil tabel.

## QG-19 Cara menggunakan filter Named/Unnamed/Fresh/Stale

- **Tujuan:** mengelompokkan observations.
- **Role/access:** semua approved user.
- **Halaman awal:** Observed LAN Hosts.
- **Jalur menu:** bar filter.
- **Urutan:** klik All, Named, Unnamed, Fresh, atau Stale.
- **Input:** satu filter aktif; dapat digabung dengan search.
- **Hasil:** tabel dan visible count diperbarui; angka kategori tetap berdasarkan seluruh dataset.
- **Catatan:** Named berarti ada inventory name **atau** NetBIOS name; Fresh=`current`, Stale=`stale`.
- **Screenshot:** SHOT-019.
- **Callout:** 1 All, 2 Named, 3 Unnamed, 4 Fresh, 5 Stale, 6 count.

## QG-20 Cara sorting Device A–Z / Z–A

- **Tujuan:** mengurutkan effective display name.
- **Role/access:** semua approved user.
- **Halaman awal:** Observed LAN Hosts.
- **Jalur menu:** header kolom Device.
- **Urutan:** klik sekali untuk ascending → klik lagi untuk descending.
- **Input:** tidak ada.
- **Hasil:** indikator ↑/↓ dan row diurutkan case-insensitive berdasarkan inventory name → NetBIOS → IP fallback.
- **Catatan:** sorting diterapkan setelah search/filter dan tidak memutasi source dataset.
- **Screenshot:** SHOT-019.
- **Callout:** 1 header Device, 2 indikator arah, 3 urutan hasil.

## QG-21 Cara sorting IP ascending / descending

- **Tujuan:** mengurutkan alamat IPv4 numerik.
- **Role/access:** semua approved user.
- **Halaman awal:** Observed LAN Hosts.
- **Jalur menu:** header IP Address.
- **Urutan:** klik sekali ascending → klik lagi descending.
- **Input:** tidak ada.
- **Hasil:** IP diurutkan per octet numerik, bukan lexical string.
- **Catatan:** contoh `.20` berada sebelum `.100` pada ascending.
- **Screenshot:** SHOT-019.
- **Callout:** 1 header IP Address, 2 indikator arah, 3 urutan numerik.

## QG-22 Cara melihat History

- **Tujuan:** melihat event Health dan riwayat diagnostik.
- **Role/access:** semua approved user.
- **Halaman awal:** `/history`.
- **Jalur menu:** History.
- **Urutan:** pilih tab Network Health Events atau Diagnostic History → atur source/target/connection/period → buka detail sesi.
- **Input:** filter source, target, connection, period Today/7/30/custom, opsi development.
- **Hasil:** trend upload/download, summary, tabel pengujian, atau daftar event.
- **Catatan:** localhost development dikecualikan secara default; waktu mengikuti locale/browser.
- **Screenshot:** SHOT-021 dan SHOT-022.
- **Callout:** 1 tabs, 2 filters, 3 chart, 4 summary, 5 list/detail.

## QG-23 Cara melihat Alerts

- **Tujuan:** membaca alert Network Health aktif.
- **Role/access:** semua approved user.
- **Halaman awal:** `/alerts`.
- **Jalur menu:** Alerts.
- **Urutan:** buka menu Alerts → baca severity dot, judul, deskripsi, dan timestamp.
- **Input:** tidak ada.
- **Hasil:** hanya event `network_health` dengan `resolved_at` kosong ditampilkan.
- **Catatan:** halaman source saat ini tidak menyediakan acknowledge/resolve action.
- **Screenshot:** SHOT-023.
- **Callout:** 1 severity, 2 title, 3 description, 4 time, 5 empty state.

## QG-24 Cara mengelola user sebagai Admin

- **Tujuan:** mengatur role dan status akses.
- **Role/access:** Admin approved saja.
- **Halaman awal:** `/admin`.
- **Jalur menu:** Admin → User Access Control.
- **Urutan:** pilih Role → pilih status Pending/Active/Suspended → Save access.
- **Input:** role Admin/Operator/Viewer dan access status.
- **Hasil:** profil diperbarui; active=approved, suspended=rejected.
- **Catatan:** form akun sendiri disabled; proteksi self-demotion dan last-active-admin juga ada pada RPC/database.
- **Screenshot:** SHOT-029.
- **Callout:** 1 counts, 2 role, 3 status, 4 save, 5 current-account notice.

# 5. PANDUAN FITUR / FEATURE REFERENCE

Bagian ini menggunakan format ringkas yang sama untuk setiap workspace. Istilah teknis pada butir **Istilah** sebaiknya dipertahankan dalam bentuk yang tampil di aplikasi.

## 5.1 Authentication

1. **Nama/route:** Login (`/login`), Register (`/register`), dan status akun (`/pending`).
2. **Tujuan/kapan digunakan:** memulai sesi, mengajukan akun, atau melihat bahwa akun masih menunggu persetujuan/ditolak.
3. **Akses/cara membuka:** halaman publik; pengguna approved yang sudah login diarahkan ke aplikasi.
4. **Komponen:** email, password, nama pada Register, pesan validasi, tautan Login/Register, dan tombol Logout pada shell.
5. **Action/input:** Login, Register, Logout; nama minimal 2 karakter dan password minimal 8 karakter saat registrasi.
6. **Status/data:** sesi valid, kredensial tidak valid, konfirmasi email bila diberlakukan, pending, atau rejected.
7. **Workflow/hasil:** masukkan kredensial lalu submit; akun approved masuk ke Dashboard, sedangkan akun belum approved masuk ke halaman status.
8. **Empty/error/warning:** pesan login dibuat generik; jangan menuliskan password pada dokumentasi atau screenshot.
9. **Batasan:** registrasi tidak sama dengan persetujuan akses.
10. **Istilah:** Login, Register, email.
11. **Screenshot/callout/caption:** SHOT-001, SHOT-024, SHOT-025; tandai field dan action; “Halaman autentikasi dan status persetujuan akun”.

## 5.2 Application Shell dan Pengaturan Bahasa

1. **Nama/route:** shell pada seluruh route protected.
2. **Tujuan/kapan digunakan:** berpindah workspace, melihat akun/role, mengganti bahasa, dan logout.
3. **Akses:** seluruh approved user; menu Admin hanya tampak bagi Admin.
4. **Komponen:** sidebar, navigasi aktif, identitas pengguna, badge role, language selector, mobile drawer.
5. **Action/input:** pilih menu, Indonesia/English, Logout.
6. **Status/data:** menu aktif dan bahasa terpilih.
7. **Workflow/hasil:** pilihan bahasa memperbarui teks antarmuka dan dipertahankan setelah refresh.
8. **Empty/error/warning:** bila preferensi tidak valid, aplikasi memakai fallback English setelah default Indonesia tidak dapat dipakai.
9. **Batasan:** nilai teknis/runtime tidak diterjemahkan.
10. **Istilah:** Dashboard, Traffic, SNMP.
11. **Screenshot/callout/caption:** SHOT-002–003; tandai navigasi, pengguna, role, selector; “Navigasi utama dan pemilih bahasa NetOps Monitor”.

## 5.3 Dashboard, Network Health, dan Discovery

1. **Nama/route:** Dashboard (`/dashboard`).
2. **Tujuan/kapan digunakan:** ringkasan kondisi jaringan, Health Watch, traffic lokal, diagnostics, event, peta reachability, tren, dan Discovery on-demand.
3. **Akses:** semua approved user melihat; aksi Manual Ping/Discovery hanya Admin dan Operator sesuai capability runner.
4. **Komponen:** status cards, target kritis/lainnya, detail Health, Other known targets, Reachability Map, Health Trends, recent events, tombol Discover.
5. **Action/input:** buka detail target, Manual Ping pada target yang sudah dikenal, pilih runner untuk Discovery; tidak ada input IP/CIDR bebas.
6. **Status/data:** online/degraded/offline, latency, packet loss, freshness, capability/runner availability, hasil discovery.
7. **Workflow/hasil:** pilih target untuk detail atau jalankan Discovery; hasil dapat diperiksa, diberi nama, atau ditambahkan ke Health Watch sesuai role.
8. **Empty/error/warning:** status kosong dan kegagalan aman ditampilkan; Manual Ping disabled jika capability tidak tersedia.
9. **Batasan:** Ping manual bersifat sesaat dan tidak mengubah status Health Watch terjadwal; Discovery dibatasi konteks jaringan runner.
10. **Istilah:** Health Watch, Reachability, Latency, Packet Loss, Network Discovery.
11. **Screenshot/callout/caption:** SHOT-004–006 dan SHOT-026; tandai cards, target, map, trends, Discover; “Dashboard dan ringkasan kesehatan jaringan”.

## 5.4 Traffic Live

1. **Nama/route:** Traffic (`/traffic`).
2. **Tujuan/kapan digunakan:** melihat traffic header/metadata yang tampak pada interface perangkat runner.
3. **Akses:** semua approved user melihat; Admin/Operator memulai dan menghentikan capture.
4. **Komponen:** runner, batas waktu, status session, RX/TX, packets per second, active flows, top talker, protocol, tab flows/conversations/talkers.
5. **Action/input:** pilih runner dan durasi 5/10/15/30 menit; Start/Stop; cari flow; filter protocol/status; buka detail.
6. **Status/data:** runner online, starting/running/stopping/completed/error, byte/packet rate, endpoint dan protocol.
7. **Workflow/hasil:** start capture, amati metrik dan daftar, filter bila perlu, lalu stop atau tunggu batas waktu.
8. **Empty/error/warning:** empty flow state; kegagalan runner/capture dinormalisasi; warning penyimpanan pada ambang yang ditampilkan UI.
9. **Batasan:** scope “This Device”, bukan seluruh LAN dan bukan pengukuran available bandwidth; browser tidak mengirim packet filter bebas.
10. **Istilah:** Traffic, RX, TX, Flow, TCP, UDP, ICMP.
11. **Screenshot/callout/caption:** SHOT-020; tandai runner, duration, status, metrics, tabs, filters; “Workspace Traffic Live pada perangkat runner”.

## 5.5 History

1. **Nama/route:** History (`/history`).
2. **Tujuan/kapan digunakan:** meninjau event Network Health dan hasil LAN Diagnostics sebelumnya.
3. **Akses:** semua approved user.
4. **Komponen:** tab history, period/filter, trend, summary, daftar sesi/event, detail path.
5. **Action/input:** pilih sumber, target, connection, Today/7 days/30 days/custom, serta opsi data development.
6. **Status/data:** timestamp, upload/download, min/max/average, result status, hop latency/loss.
7. **Workflow/hasil:** pilih tab dan filter, baca chart/summary, lalu buka sesi untuk detail.
8. **Empty/error/warning:** empty state mengikuti filter; localhost development dikecualikan secara default.
9. **Batasan:** timestamp ditampilkan menurut locale aktif/browser.
10. **Istilah:** Diagnostic History, MTR, upload, download.
11. **Screenshot/callout/caption:** SHOT-021–022; tandai tabs, filters, trend, sessions; “Riwayat diagnostik dan event kesehatan jaringan”.

## 5.6 Alerts

1. **Nama/route:** Alerts (`/alerts`).
2. **Tujuan/kapan digunakan:** membaca event Network Health aktif yang belum resolved.
3. **Akses:** semua approved user.
4. **Komponen:** daftar alert, severity, title, description, timestamp.
5. **Action/input:** tidak ada action acknowledge/resolve pada UI yang diaudit.
6. **Status/data:** hanya source `network_health` dengan `resolved_at` kosong, urutan terbaru.
7. **Workflow/hasil:** buka Alerts lalu prioritaskan berdasarkan severity dan informasi kejadian.
8. **Empty/error/warning:** pesan kosong atau gagal memuat.
9. **Batasan:** halaman bersifat read-only.
10. **Istilah:** Alert, Severity, resolved.
11. **Screenshot/callout/caption:** SHOT-023; tandai severity dan detail; “Daftar alert Network Health yang masih aktif”.

## 5.7 Devices, Health Watch, dan Device Profile

1. **Nama/route:** Devices (`/devices`) dan Device Profile drawer.
2. **Tujuan/kapan digunakan:** mengelola inventory, konfigurasi Health Watch, serta melihat identitas/telemetry perangkat.
3. **Akses:** semua approved user melihat; Admin/Operator menambah, mengubah, menghapus, menginspeksi, dan mengelola Health Watch.
4. **Komponen:** search/list inventory, form Add/Edit, panel Health Watch, Delete confirmation, Device Profile.
5. **Action/input:** IPv4 dan nama wajib; tipe, lokasi, catatan opsional; Health Watch memakai runner, interval, timeout, threshold failure/recovery/latency/loss, Enabled, Critical.
6. **Status/data:** identitas, lokasi, Health status, detected identity, capabilities, network identity, Management Telemetry.
7. **Workflow/hasil:** Add Device menyimpan inventory; Health Watch dan SNMP dikonfigurasi terpisah; Device Profile dapat dibuka dari beberapa surface.
8. **Empty/error/warning:** duplicate IP tidak ditimpa; delete diblokir bila masih direferensikan Health Watch atau Managed SNMP Target.
9. **Batasan:** menonaktifkan Health Watch belum menghapus konfigurasi; IP inventory tidak diedit dari form edit.
10. **Istilah:** Device, Network Node, Device Profile, Device Inspector, Health Watch, Managed Telemetry.
11. **Screenshot/callout/caption:** SHOT-007–014; tandai form, actions, dependency warning, profile; “Pengelolaan Device Inventory dan konfigurasi pemantauan”.

## 5.8 Managed SNMP

1. **Nama/route:** SNMP (`/snmp`) dan detail target.
2. **Tujuan/kapan digunakan:** konfigurasi polling read-only dan membaca identity/interface telemetry.
3. **Akses:** semua approved user melihat; Admin/Operator menambah, mengubah, dan menghapus target.
4. **Komponen:** summary, target table/cards, form target, detail system identity, interface table, warning/event.
5. **Action/input:** node, runner, version 3/2c, port, interval 30/60 detik, credential profile reference, threshold error/discard/utilization, sustained duration, Enabled.
6. **Status/data:** active/disabled, connected/error/partial, profile availability, last poll, sysName/sysDescr/System Object ID/uptime, interface rates/utilization/counters.
7. **Workflow/hasil:** buat target dari node inventory, pastikan profile reference tersedia pada runner, simpan, lalu baca hasil setelah poll.
8. **Empty/error/warning:** snapshot dapat kosong/stale/error; nilai tidak tersedia memakai placeholder UI; credential secret tidak pernah ditampilkan.
9. **Batasan:** Device Inventory dan Managed SNMP Target adalah konsep terpisah; Linux logical interface tidak otomatis berarti port fisik.
10. **Istilah:** SNMP, OID, Managed Telemetry, interface, RX/TX, credential profile reference.
11. **Screenshot/callout/caption:** SHOT-015–018; tandai status, form, identity, interfaces, delete; “Konfigurasi dan detail Managed SNMP Target”.

## 5.9 Observed LAN Hosts

1. **Nama/route:** Observed LAN Hosts (`/snmp/[targetId]/hosts`).
2. **Tujuan/kapan digunakan:** membaca neighbor IPv4 privat yang diamati melalui target Managed SNMP.
3. **Akses:** semua approved user, read-only.
4. **Komponen:** counts, search, filter All/Named/Unnamed/Fresh/Stale, sortable Device/IP headers, host table.
5. **Action/input:** search nama/IP/MAC; pilih filter; klik Device atau IP Address untuk asc/desc.
6. **Status/data:** effective device name, IP, MAC, NetBIOS, evidence, freshness, first/last seen.
7. **Workflow/hasil:** buka target SNMP, masuk Observed LAN Hosts, cari/filter/sort dataset yang sudah dimuat.
8. **Empty/error/warning:** zero state menampilkan count yang masuk akal; field kosong memakai `-`; notice enrichment parsial dapat muncul.
9. **Batasan:** neighbor evidence bukan bukti attachment fisik, switch-port membership, atau topology discovery.
10. **Istilah:** Observed LAN Hosts, NetBIOS, Fresh, Stale, Named, Unnamed.
11. **Screenshot/callout/caption:** SHOT-019; satu full-page dapat mencakup filter dan sorting; “Daftar Observed LAN Hosts beserta pencarian, filter, dan sorting”.

## 5.10 LAN Diagnostics

1. **Nama/route:** LAN Diagnostics (`/diagnostics`).
2. **Tujuan/kapan digunakan:** pengujian on-demand reachability, bandwidth dua arah, dan path Layer-3.
3. **Akses:** semua approved user melihat; Admin/Operator menjalankan.
4. **Komponen:** source/target, current network, route/preflight, Run Diagnostic, progress, upload/download, path/hops, history ringkas.
5. **Action/input:** pilih source dan target yang diizinkan serta durasi yang tersedia; tidak ada command bebas.
6. **Status/data:** runner/context/route/target/iperf readiness, Mbps, peak/min, retransmits, responding hops, latency/loss.
7. **Workflow/hasil:** pilih pasangan, periksa preflight, run, tunggu completion, interpretasikan bandwidth dan hop.
8. **Empty/error/warning:** dependency optional dapat unavailable; hasil parsial/gagal dinormalisasi.
9. **Batasan:** iperf3 menghasilkan traffic aktif; hop count hanya hop Layer-3 yang merespons dan bukan jumlah switch/kabel/AP bridge.
10. **Istilah:** Ping, MTR, iperf3, latency, packet loss, Layer-3 path.
11. **Screenshot/callout/caption:** SHOT-027–028; tandai target/preflight/run dan output; “Pelaksanaan dan hasil LAN Diagnostics”.

## 5.11 Admin dan User Access Control

1. **Nama/route:** Admin (`/admin`).
2. **Tujuan/kapan digunakan:** mengatur role dan approval status akun.
3. **Akses:** Admin approved saja; menu tidak ditampilkan kepada Operator/Viewer dan route dijaga server-side.
4. **Komponen:** ringkasan jumlah, daftar user, role selector, status selector, Save.
5. **Action/input:** Admin/Operator/Viewer; Pending/Active/Suspended.
6. **Status/data:** pending dipetakan ke pending, active ke approved, suspended ke rejected.
7. **Workflow/hasil:** pilih akses user lain dan simpan; metadata approval dipertahankan ketika user approved hanya berubah role.
8. **Empty/error/warning:** akun sendiri disabled; proteksi self-demotion dan last-active-admin berlaku.
9. **Batasan:** role tanpa status approved tidak memberi akses operasional.
10. **Istilah:** Admin, Operator, Viewer, approved.
11. **Screenshot/callout/caption:** SHOT-029; tandai counts, role, status, save; “User Access Control untuk persetujuan dan role pengguna”.

# 6. LIFECYCLE DEVICE INVENTORY

## 6.1 Menambahkan Device

1. Admin/Operator membuka **Devices** (`/devices`) dan memilih **Add Device**.
2. Isi IPv4 host dan nama perangkat. Tipe, lokasi, dan catatan bersifat opsional.
3. Validasi source: IPv4 harus valid; nama maksimal 200 karakter, lokasi 200, dan catatan 2.000. IPv4 bukan input CIDR.
4. Pilih action simpan. Jika IP sudah ada, aplikasi menampilkan notice bahwa device sudah terdaftar dan tidak menimpa identity lama.
5. Jika berhasil, entry muncul di daftar inventory dan dapat dibuka sebagai Device Profile.

Menambahkan Device hanya membuat/menyimpan Network Node. Tindakan ini **tidak otomatis** mengaktifkan Health Watch atau Managed SNMP.

## 6.2 Mengubah Device

Admin/Operator memilih **Edit** pada entry. Nama, tipe, lokasi, dan catatan dapat diubah; IP menjadi identitas tetap pada form edit. Viewer hanya dapat membaca.

## 6.3 Menghapus Device dan dependency

Action delete lebih dahulu memeriksa referensi pada `network_targets` dan `managed_telemetry_targets`. Pemeriksaan Health Watch tidak hanya mencari target enabled; konfigurasi yang disabled tetapi masih tersimpan tetap menjadi dependency.

- Jika ada Health Watch, UI menjelaskan agar konfigurasi tersebut dihapus melalui **Kelola Health Watch**.
- Jika ada Managed SNMP Target, UI menjelaskan agar target SNMP dihapus terlebih dahulu.
- Jika keduanya ada, pesan menyebut kedua dependency.
- Relasi Network Node sendiri bukan konfigurasi tambahan yang harus dilepas user.

Urutan aman yang didukung source:

`Device Inventory → Kelola Health Watch → Remove konfigurasi Health Watch → SNMP → Delete target terkait (jika ada) → kembali ke Device Inventory → Delete Device → konfirmasi`.

Database memiliki cascade untuk beberapa row turunan, tetapi UI/action secara sengaja memblokir delete selama dua konfigurasi utama masih mereferensikan node. Manual tidak boleh mengarahkan user mengandalkan cascade. Setelah konfirmasi berhasil, node hilang dari Device Inventory; Health Watch/SNMP harus sudah dilepas.

# 7. LIFECYCLE HEALTH WATCH

## 7.1 Mengaktifkan

Pada `/devices`, Admin/Operator membuka **Kelola Health Watch** pada Device. Pilih runner, interval (15–3.600 detik), timeout (250–5.000 ms), failures menuju offline (2–10), successes menuju recovery (1–5), latency warning (1–60.000 ms), loss warning (0–100%), serta Enabled/Critical. Simpan membuat atau memperbarui konfigurasi untuk pasangan runner-node.

## 7.2 Membaca dan mengubah

Status hasil monitoring muncul pada Devices dan Dashboard sebagai online/degraded/offline beserta latency/loss/freshness yang tersedia. Pada konfigurasi yang sudah ada, node dan runner dipertahankan; parameter threshold dan flags dapat diedit lalu disimpan.

## 7.3 Menonaktifkan versus menghapus

- Mengosongkan **Enabled** dan menyimpan menghentikan monitoring aktif, tetapi row konfigurasi tetap ada.
- **Remove** menghapus konfigurasi Health Watch saja; Device Inventory tetap ada.
- Untuk menghapus Device, konfigurasi Health Watch harus benar-benar di-**Remove**. Menonaktifkannya saja belum melepaskan dependency.

Manual Ping merupakan action sesaat pada target yang sudah dikenal. Hasil loading/success/error bersifat ephemeral dan tidak mengganti status hasil Health Watch terjadwal.

# 8. LIFECYCLE MANAGED SNMP TARGET

## 8.1 Menambahkan target

1. Pastikan Device/Network Node sudah ada di Device Inventory.
2. Buka `/snmp`, pilih **Add target**.
3. Pilih node dan runner, lalu isi SNMP version (`3` atau `2c`), port (1–65.535), polling interval (30/60 detik), credential profile reference, threshold oper error/discard/utilization, sustained duration, dan Enabled.
4. Credential field adalah **reference** maksimal 64 karakter dengan format yang diizinkan; password/community/auth/priv secret tidak dikirim atau disimpan melalui form.
5. Saat target enabled, reference harus termasuk profile yang diiklankan runner. Validasi menolak input atau threshold di luar batas; critical utilization tidak boleh lebih rendah dari warning.
6. Simpan. Konflik pasangan runner-node diperbarui melalui contract upsert sehingga tidak membuat target duplikat.

## 8.2 Setelah dibuat dan diedit

Target muncul pada workspace SNMP dengan active/disabled, hasil status terakhir, profile available/unavailable, dan waktu poll. Detail memperlihatkan system identity, connection state, interface telemetry, rate/utilization, serta event/warning bila tersedia. Node dan runner dikunci pada form edit; parameter lain yang ditampilkan tetap dapat disimpan.

## 8.3 Menghapus target

Admin/Operator memilih delete lalu menyetujui confirmation dialog. Penghapusan Managed SNMP Target tidak menghapus Device Inventory atau konfigurasi Health Watch. Latest device/interface dan observed-host rows mempunyai cascade terhadap target pada schema yang diaudit. Presentasi event historis setelah target dihapus: **Perlu diverifikasi pada running UI**.

## 8.4 Hubungan dengan Device Inventory

Device Inventory adalah identitas/node yang dapat dipakai banyak fitur. Managed SNMP Target adalah konfigurasi polling terpisah yang mereferensikan node dan runner. Menambah Device tidak mengaktifkan SNMP; menghapus target SNMP tidak menghapus Device. Sebaliknya, Device tidak dapat dihapus melalui action UI selama Managed SNMP Target masih mereferensikannya.

# 9. OBSERVED LAN HOSTS

## 9.1 Sumber dan arti data

Workspace ini menampilkan observasi neighbor IPv4 privat yang sudah dipersistensikan untuk Managed SNMP Target. Otoritas membership berasal dari telemetry SNMP; enrichment NetBIOS hanya melengkapi nama dan tidak menambah membership.

## 9.2 Display name dan kategori

Prioritas nama yang dilihat user adalah: **nama Inventory/Network Node → nama NetBIOS → IP Address**.

- **All:** seluruh observations yang sudah dimuat.
- **Named:** mempunyai nama inventory **atau** nama NetBIOS.
- **Unnamed:** tidak mempunyai keduanya.
- **Fresh:** `status === current`.
- **Stale:** `status === stale`.

Count pada tiap filter berasal dari keseluruhan dataset yang dimuat, bukan dari filter yang sedang aktif. `Devices: X / Y` berarti X hasil setelah search/filter dan Y total sebelum search/filter.

## 9.3 Search dan sorting

Search bersifat case-insensitive dan mencakup nama inventory/device, nama NetBIOS, IP, dan MAC. Sorting baru aktif setelah header diklik dan tidak memutasi source array:

- **Device:** ascending A–Z, klik lagi descending Z–A; comparison case-insensitive, lalu IP numerik sebagai tie-break.
- **IP Address:** ascending/descending berdasarkan nilai empat oktet IPv4, bukan lexical string.

Tanpa sort eksplisit, urutan bawaan yang ada dipertahankan (current lebih dahulu dan recency sesuai data yang disiapkan).

## 9.4 Kolom dan placeholder

Kolom yang tampil: Device, IP Address, MAC Address, NetBIOS Name, Observation Evidence, Freshness, First Seen, dan Last Seen. MAC invalid/zero/tidak ada dan nama NetBIOS kosong ditampilkan sebagai hyphen ASCII `-`, bukan em dash.

## 9.5 Partial enrichment dan batas interpretasi

NetBIOS adalah enrichment opsional dan bounded; sebagian host dapat tetap tanpa nama. Notice partial berarti proses enrichment tidak lengkap, bukan berarti seluruh neighbor observation tidak valid. Evidence neighbor tidak membuktikan perangkat terhubung secara fisik langsung, tidak membuktikan keanggotaan switch port, serta bukan hasil topology discovery. Timestamp First Seen/Last Seen menjelaskan waktu observasi tersimpan, bukan waktu perangkat dipasang secara fisik.

# 10. LAN DIAGNOSTICS

| Capability | Entry point dan input | Output/sukses | Gagal/dependency | Pemahaman user |
|---|---|---|---|---|
| Ping/Reachability | Preflight Diagnostics; source dan target allowlisted | Target reachable dan latency bila merespons | Timeout/unreachable dinormalisasi; ICMP dapat dibatasi environment | Reachable hanya membuktikan respons dari jalur saat tes. |
| Latency | Ping/MTR pada diagnostic session | ms per target/hop dan ringkasan tertinggi | Tidak tersedia bila hop tidak merespons | Latency adalah waktu round trip, bukan jarak fisik. |
| Packet Loss | MTR/path result | Persentase loss pada responding hop | Hop dapat tidak menjawab walau forwarding bekerja | Loss satu hop perlu dibaca bersama hop berikutnya. |
| MTR/Path | One-Click Diagnostics | responding hops, avg latency, loss | **Optional**: bergantung tool/capability runner | Hop count adalah langkah Layer-3 yang merespons, bukan switch/kabel/AP bridge. |
| Bandwidth/iperf3 | One-Click Diagnostics; target dengan server iperf3 siap | upload/download Mbps, peak, minimum, retransmits | **Optional/environment-dependent**; server/port harus tersedia | Tes menghasilkan traffic aktif dan mengukur jalur ke target iperf3, bukan link speed nominal. |
| One-Click Diagnostics | `/diagnostics`; pilih source, target, durasi lalu Run | preflight → upload → download → path → save | Dapat berhenti aman dengan kode kegagalan normalized | Baca bandwidth dan path sebagai satu sesi pada waktu tertentu. |

Runner/context/route/target readiness diperiksa sebelum tes. Target dan source harus berasal dari konfigurasi yang diizinkan; browser tidak dapat mengirim command atau target arbitrary. Pengujian ke localhost diberi penanda development dan bukan pengukuran LAN.

# 11. PENGATURAN BAHASA

- Bahasa yang didukung tepat **Indonesia** (`id`) dan **English** (`en`).
- Default aplikasi adalah Indonesia; fallback translation adalah English.
- Pemilih bahasa berada pada application shell/sidebar. Pengguna memilih nama bahasa, bukan locale teknis.
- Pilihan disimpan dalam cookie selama satu tahun sehingga tetap berlaku setelah refresh. Perubahan juga memperbarui state bahasa di client dan meminta refresh route agar konten server-rendered mengikuti pilihan baru.
- Format tanggal/waktu menggunakan locale `id-ID` atau `en-US` sesuai bahasa aktif pada helper yang diaudit. Tampilan akhir timezone/timestamp: **Perlu diverifikasi pada running UI**.
- IP, MAC, hostname, interface, model, OID, protocol, angka pengukuran, database ID, error code, dan command tidak diterjemahkan. Istilah mapan seperti Dashboard, Traffic, SNMP, Health Watch, Device Inspector, Managed Telemetry, dan Network Discovery dapat dipertahankan agar konsisten dengan UI.

# 12. DAFTAR SCREENSHOT YANG DIPERLUKAN

Kolom **Callout** merujuk nomor elemen yang perlu disorot. Jenis anotasi mengikuti pedoman: marker untuk beberapa kontrol, arrow untuk action spesifik, outline box untuk panel, dan circle hanya untuk satu kontrol prioritas.

| ID | Feature | Page/navigation path | Purpose | Type | Required UI state | Suggested callouts | Annotation | Caption Bahasa Indonesia |
|---|---|---|---|---|---|---|---|---|
| SHOT-001 | Login | `/login` | Memperkenalkan login | Full page | Form kosong tanpa error | 1 Email; 2 Password; 3 Login; 4 Register | Numbered markers | Gambar X.X Halaman login NetOps Monitor |
| SHOT-002 | Application shell | Dashboard setelah login | Menjelaskan navigasi dan akun | Full page | Sidebar terbuka, menu aktif | 1 Sidebar; 2 Active menu; 3 User/role; 4 Logout | Numbered markers | Gambar X.X Navigasi utama dan informasi pengguna |
| SHOT-003 | Language | Sidebar | Menunjukkan pemilih bahasa | Cropped | Selector terbuka | 1 Indonesia; 2 English | Outline box + markers | Gambar X.X Pemilih bahasa Indonesia dan English |
| SHOT-004 | Dashboard | `/dashboard` | Ikhtisar workspace | Full page | Cards dan data terisi | 1 Overall status; 2 Traffic; 3 Health; 4 Diagnostics | Numbered markers | Gambar X.X Dashboard NetOps Monitor |
| SHOT-005 | Network Health | Dashboard → target | Membaca kondisi target | Cropped | Target online/degraded/offline dan detail terbuka | 1 Status; 2 Latency; 3 Loss; 4 Last check; 5 Ping | Numbered markers | Gambar X.X Detail Network Health perangkat |
| SHOT-006 | Network Discovery | Dashboard → Discover | Menjelaskan discovery on-demand | Full drawer | Runner dipilih dan hasil tersedia | 1 Runner; 2 Start; 3 Results; 4 Inspect/Name/Health | Numbered markers + arrows | Gambar X.X Hasil Network Discovery melalui runner |
| SHOT-007 | Devices | `/devices` | Memperkenalkan inventory | Full page | Beberapa device tampil | 1 Search; 2 Add Device; 3 Device row; 4 Actions | Numbered markers | Gambar X.X Daftar Device Inventory |
| SHOT-008 | Add Device | Devices → Add Device | Menjelaskan field pembuatan | Cropped form | Form kosong | 1 IP; 2 Name; 3 Type; 4 Location; 5 Notes; 6 Save | Numbered markers | Gambar X.X Form penambahan Device Inventory |
| SHOT-009 | Health Watch | Devices → Kelola Health Watch | Menjelaskan aktivasi | Cropped form | Device belum dikonfigurasi | 1 Runner; 2 Interval/timeout; 3 Thresholds; 4 Enabled/Critical; 5 Add | Numbered markers | Gambar X.X Form aktivasi Health Watch |
| SHOT-010 | Kelola Health Watch | Devices → target terpantau | Menjelaskan edit | Cropped panel | Konfigurasi existing | 1 Identity; 2 Locked runner; 3 Settings; 4 Save | Numbered markers | Gambar X.X Pengelolaan konfigurasi Health Watch |
| SHOT-011 | Remove/Disable Health | Panel Health Watch | Membedakan disable dan remove | Cropped | Enabled terlihat dan Remove tersedia | 1 Enabled; 2 Save; 3 Remove | Markers + arrows | Gambar X.X Pilihan menonaktifkan atau menghapus Health Watch |
| SHOT-012 | Device dependency | Devices → Delete | Menunjukkan delete diblokir | Cropped message | Device masih direferensikan Health/SNMP | 1 Warning; 2 Instruksi dependency | Outline box | Gambar X.X Peringatan dependency sebelum menghapus device |
| SHOT-013 | Delete Device | Devices → Delete | Menunjukkan konfirmasi final | Cropped dialog | Dependency sudah dilepas | 1 Identity; 2 Cancel; 3 Confirm delete | Numbered markers | Gambar X.X Konfirmasi penghapusan Device Inventory |
| SHOT-014 | Device Profile | Buka device dari surface mana pun | Menjelaskan profil reusable | Full drawer | Identity dan telemetry tersedia | 1 Identity; 2 Network; 3 Inspector; 4 Management Telemetry | Numbered markers + outline boxes | Gambar X.X Device Profile dan informasi perangkat |
| SHOT-015 | Add SNMP Target | `/snmp` → Add target | Menjelaskan konfigurasi target | Full form | Form kosong tanpa secret | 1 Node/runner; 2 Version/port; 3 Profile ref; 4 Interval; 5 Threshold; 6 Enabled/Save | Numbered markers | Gambar X.X Form penambahan Managed SNMP Target |
| SHOT-016 | SNMP target list/status | `/snmp` | Membaca target dan status | Full page | Active dan disabled target bila tersedia | 1 Summary; 2 Target; 3 Connection; 4 Profile; 5 Last poll; 6 Actions | Numbered markers | Gambar X.X Daftar dan status Managed SNMP Target |
| SHOT-017 | SNMP detail | SNMP → pilih target | Membaca system/interface telemetry | Full page | Snapshot connected terisi | 1 System name; 2 System Object ID; 3 Uptime; 4 Interfaces; 5 Rates/utilization | Numbered markers + outline boxes | Gambar X.X Detail sistem dan interface Managed Telemetry |
| SHOT-018 | Delete SNMP | SNMP → Delete target | Menunjukkan confirmation | Cropped dialog | Dialog terbuka | 1 Target identity; 2 Cancel; 3 Delete | Numbered markers | Gambar X.X Konfirmasi penghapusan Managed SNMP Target |
| SHOT-019 | Observed LAN Hosts | SNMP → target → Observed LAN Hosts | Mencakup full page, search/filter, dan sorting tanpa duplikasi screenshot | Full page | Data Named/Unnamed dan Fresh/Stale terlihat; sort aktif | 1 Counts; 2 Search; 3 Filters; 4 Device sort; 5 IP sort; 6 Table; 7 Limitation notice | Numbered markers + outline box | Gambar X.X Observed LAN Hosts beserta pencarian, filter, dan sorting |
| SHOT-020 | Traffic Live | `/traffic` | Menjelaskan capture dan metrics | Full page | Session running dengan flow | 1 Runner/duration; 2 Stop; 3 RX/TX; 4 Rates; 5 Tabs; 6 Filters | Numbered markers | Gambar X.X Traffic Live pada perangkat runner |
| SHOT-021 | Diagnostic History | `/history` → Diagnostic History | Menjelaskan filter dan hasil sesi | Full page | Filter dan trend berisi data | 1 Tab; 2 Period/filter; 3 Trend; 4 Summary; 5 Sessions | Numbered markers | Gambar X.X Riwayat hasil LAN Diagnostics |
| SHOT-022 | Health history | `/history` → Network Health Events | Menjelaskan event history | Full page | Daftar event terisi | 1 Tab; 2 Filters; 3 Event; 4 Timestamp/status | Numbered markers | Gambar X.X Riwayat event Network Health |
| SHOT-023 | Alerts | `/alerts` | Menjelaskan alert aktif | Full page | Alert beberapa severity | 1 Severity; 2 Title; 3 Description; 4 Time | Numbered markers | Gambar X.X Alert Network Health yang belum resolved |
| SHOT-024 | Register | `/register` | Menjelaskan pengajuan akun | Full page | Form kosong | 1 Name; 2 Email; 3 Password; 4 Register | Numbered markers | Gambar X.X Form registrasi akun pengguna |
| SHOT-025 | Pending approval | `/pending` | Menjelaskan approval flow | Full page | Akun pending | 1 Status message; 2 Logout/navigation action | Outline box + arrow | Gambar X.X Status akun yang menunggu persetujuan Admin |
| SHOT-026 | Reachability dan Trends | Dashboard | Menjelaskan peta dan tren | Full/cropped region | Map dan chart berisi data | 1 Nodes; 2 Edges; 3 Status legend; 4 Trend controls/chart | Numbered markers + outline boxes | Gambar X.X Reachability Map dan Health Trends |
| SHOT-027 | LAN Diagnostics | `/diagnostics` | Menjelaskan selection/preflight | Full page | Target dipilih, preflight tampil | 1 Source; 2 Target; 3 Duration; 4 Preflight; 5 Run | Numbered markers + arrow | Gambar X.X Persiapan One-Click LAN Diagnostics |
| SHOT-028 | Diagnostic result | Diagnostics sesudah selesai | Menginterpretasikan hasil | Full page | Upload/download/path lengkap atau partial realistis | 1 Status; 2 Upload; 3 Download; 4 Hops; 5 Latency/loss; 6 Notes | Numbered markers + outline boxes | Gambar X.X Hasil bandwidth dan Layer-3 path |
| SHOT-029 | Admin/User Access | `/admin` | Menjelaskan approval dan role | Full page | Beberapa status user, tanpa data sensitif | 1 Counts; 2 User; 3 Role; 4 Status; 5 Save; 6 Current-account notice | Numbered markers | Gambar X.X User Access Control untuk Admin |

# 13. DAFTAR CALLOUT GAMBAR

| Callout ID | Digunakan pada | Yang disorot | Bentuk yang disarankan |
|---|---|---|---|
| CALL-AUTH-01 | SHOT-001/024 | Urutan field dan submit autentikasi | Numbered marker |
| CALL-SHELL-01 | SHOT-002/003 | Menu aktif, role, bahasa, logout | Numbered marker; outline untuk selector |
| CALL-DASH-01 | SHOT-004 | Empat region ringkasan utama | Outline box |
| CALL-HEALTH-01 | SHOT-005/026 | Status, latency/loss, map, trends | Numbered marker |
| CALL-DISC-01 | SHOT-006 | Runner, start, hasil, action | Numbered marker + arrow pada Start |
| CALL-DEVICE-01 | SHOT-007/008 | Search, Add, field, Save | Numbered marker |
| CALL-HEALTHCFG-01 | SHOT-009–011 | Runner, thresholds, Enabled, Save, Remove | Numbered marker + arrow |
| CALL-DELETE-01 | SHOT-012/013 | Dependency warning dan confirm | Outline warning; circle pada destructive action hanya bila perlu |
| CALL-PROFILE-01 | SHOT-014 | Region identity/inspector/telemetry | Outline box |
| CALL-SNMP-01 | SHOT-015–018 | Form, connection, identity, interface, delete | Numbered marker |
| CALL-HOST-01 | SHOT-019 | Search, five filters, counts, sortable headers, warning | Numbered marker; outline warning |
| CALL-TRAFFIC-01 | SHOT-020 | Session controls, metrics, tabs, filters | Numbered marker |
| CALL-HISTORY-01 | SHOT-021/022 | Tab, filters, chart/list/detail | Numbered marker |
| CALL-ALERT-01 | SHOT-023 | Severity dan detail alert | Numbered marker |
| CALL-DIAG-01 | SHOT-027/028 | Target, preflight, run, bandwidth, path | Numbered marker + arrow pada Run |
| CALL-ADMIN-01 | SHOT-029 | Role/status/save dan proteksi akun sendiri | Numbered marker + outline notice |

Untuk cetak A4, batasi marker pada elemen yang benar-benar dijelaskan di paragraf terkait. Gunakan warna kontras yang masih terbaca dalam grayscale dan jangan menutup IP, label, atau nilai pengukuran penting.

# 14. GLOSARIUM

| Term | Penjelasan singkat dalam Bahasa Indonesia | Keep English/technical term? | Catatan |
|---|---|---|---|
| IP Address | Alamat numerik perangkat pada jaringan IP. | Yes | Nilai mentah tidak diterjemahkan. |
| MAC Address | Identitas link-layer pada interface jaringan. | Yes | Nilai kosong/zero tidak dianggap MAC valid. |
| Hostname | Nama host yang dilaporkan atau disimpan. | Yes | Dapat berbeda dari nama inventory. |
| Network Node | Identitas jaringan tersimpan yang menjadi dasar Device Inventory. | Yes | Dapat direferensikan Health dan SNMP. |
| Device | Perangkat/entry yang ditampilkan dalam inventory. | Yes | Bukan otomatis sebuah SNMP target. |
| Reachability | Kemampuan target merespons melalui jalur jaringan saat diperiksa. | Yes | Respons sesaat bukan jaminan ketersediaan berkelanjutan. |
| Latency | Waktu round trip, biasanya dalam ms. | Yes | Bukan ukuran jarak fisik. |
| Packet Loss | Persentase paket uji yang tidak memperoleh respons. | Yes | Interpretasikan bersama keseluruhan path. |
| Traffic | Data jaringan yang terlihat pada interface runner. | Yes | Scope Traffic Live adalah This Device. |
| RX | Data yang diterima interface. | Yes | Receive. |
| TX | Data yang dikirim interface. | Yes | Transmit. |
| Flow | Ringkasan komunikasi antar-endpoint/protocol. | Yes | Berdasarkan metadata yang tersedia. |
| Packet | Unit data yang melewati jaringan. | Yes | UI dapat menampilkan packet rate. |
| TCP | Protokol transport connection-oriented. | Yes | Nilai protocol tidak diterjemahkan. |
| UDP | Protokol transport datagram. | Yes | Nilai protocol tidak diterjemahkan. |
| ICMP | Protokol kontrol yang digunakan antara lain untuk Ping. | Yes | Respons dapat dibatasi perangkat/firewall. |
| SNMP | Protokol untuk membaca telemetry perangkat terkelola. | Yes | Implementasi memakai profile read-only lokal. |
| OID | Identifier objek data pada SNMP. | Yes | Nilai OID tidak diterjemahkan. |
| NetBIOS | Mekanisme enrichment nama host yang bersifat opsional. | Yes | Nama tidak dijamin tersedia. |
| MTR | Pengukuran path Layer-3, latency, dan loss per hop yang merespons. | Yes | Tool/capability dapat optional. |
| iperf3 | Tool pengujian throughput antara client dan server. | Yes | Menghasilkan traffic aktif. |
| Fresh | Observasi berstatus current/masih terkini. | Yes | Berdasarkan freshness persistence aplikasi. |
| Stale | Observasi lama yang tidak hadir pada observasi current. | Yes | Row tetap dipertahankan. |
| Named | Observed host dengan nama inventory atau NetBIOS. | Yes | Tidak hanya berarti NetBIOS. |
| Unnamed | Observed host tanpa nama inventory maupun NetBIOS. | Yes | IP menjadi display fallback. |
| Observed Host | Neighbor privat yang diamati melalui telemetry target. | Yes | Bukan bukti topology fisik. |
| Health Watch | Pemantauan ICMP terjadwal untuk target tersimpan. | Yes | Terpisah dari Ping manual. |
| Managed Telemetry | Snapshot sistem/interface yang dikumpulkan secara terkelola. | Yes | Freshness bergantung polling. |
| Network Discovery | Discovery bounded dan on-demand dari konteks runner. | Yes | Hasil tidak otomatis disimpan. |
| Device Inspector | Inspeksi aktif bounded terhadap target yang diizinkan. | Yes | Tidak dipicu otomatis oleh Traffic/MTR. |
| Severity | Tingkat kepentingan/keparahan event atau alert. | Yes | Ikuti label yang tampil di UI. |
| Alert | Event aktif yang memerlukan perhatian. | Yes | Alerts saat ini read-only. |
| Interface | Antarmuka jaringan logical atau physical. | Yes | Klasifikasi tidak selalu berarti port switch fisik. |
| Polling | Pengambilan telemetry berkala sesuai interval target. | Yes | Target disabled tidak dipoll. |
| Runner | Proses terotorisasi yang menjalankan aktivitas jaringan. | Yes | Capability menentukan action yang tersedia. |

# 15. WARNING DAN BATASAN

1. Observed LAN Hosts adalah observasi neighbor Layer-3 privat dari Managed SNMP, bukan hasil pemetaan topology fisik.
2. Neighbor evidence tidak membuktikan physical attachment, switch-port membership, jalur kabel, atau access point yang dilalui.
3. NetBIOS enrichment bersifat opsional dan bounded; host valid dapat tetap Unnamed dan enrichment dapat partial.
4. Device Inventory, Health Watch, dan Managed SNMP Target adalah tiga konsep terpisah. Menambah Device tidak otomatis mengaktifkan dua monitoring tersebut.
5. Menonaktifkan Health Watch tidak menghapus konfigurasinya. Device delete tetap diblokir sampai konfigurasi Health Watch di-Remove.
6. Managed SNMP Target juga harus dihapus sebelum Device yang direferensikan dapat dihapus.
7. Credential profile pada SNMP adalah reference; secret tersimpan di sisi runner dan tidak boleh dimasukkan ke manual/screenshot.
8. Freshness Managed Telemetry bergantung pada polling dan runner. Snapshot terakhir dapat tetap tampil ketika target disabled atau poll berikutnya gagal.
9. Interface logical pada Linux/perangkat tidak boleh dipresentasikan sebagai confirmed physical switch port.
10. Beberapa diagnostics bergantung capability/tool environment. MTR dan iperf3 tidak boleh didokumentasikan sebagai selalu tersedia.
11. iperf3 menghasilkan traffic aktif. Jalankan hanya terhadap server yang disiapkan dan diizinkan.
12. Nilai Local link speed bukan available bandwidth dan bukan hasil iperf3.
13. Hop count menunjukkan hop Layer-3 yang merespons, bukan jumlah switch, kabel, patch panel, atau bridge.
14. Ping/ICMP yang tidak merespons belum tentu membuktikan perangkat mati; firewall/policy dapat menolak respons.
15. Manual Ping bersifat sesaat dan tidak mengganti status Health Watch terjadwal.
16. Traffic Live hanya traffic yang terlihat oleh interface perangkat runner; bukan seluruh LAN dan bukan packet capture arbitrary dari browser.
17. Viewer read-only. Aksi jaringan dan pengelolaan memerlukan akun approved dengan role Admin atau Operator; Admin workspace hanya untuk Admin approved.
18. Registrasi akun tidak memberi akses langsung; approval Admin tetap diperlukan.
19. Discovery memakai scope yang diturunkan dari konteks jaringan runner dan hasilnya tidak otomatis menjadi Device Inventory.
20. History menyembunyikan data localhost/development secara default agar tidak tercampur dengan hasil LAN operasional.

# 16. HAL YANG PERLU DIVERIFIKASI MANUAL DI RUNNING UI

1. **Perlu diverifikasi pada running UI:** wording final pesan login gagal, pending, dan rejected dalam kedua bahasa serta kondisi provider konfirmasi email pada deployment.
2. **Perlu diverifikasi pada running UI:** respons layout sidebar/mobile drawer dan tidak adanya horizontal overflow pada ukuran layar yang akan dipakai dalam manual.
3. **Perlu diverifikasi pada running UI:** timezone dan format tanggal/waktu aktual untuk locale Indonesia/English pada host browser produksi.
4. **Perlu diverifikasi pada running UI:** wording serta urutan toast/dialog dependency ketika Device diblokir Health Watch saja, SNMP saja, dan keduanya.
5. **Perlu diverifikasi pada running UI:** presentasi event historis Managed Telemetry setelah Managed SNMP Target dihapus.
6. **Perlu diverifikasi pada running UI:** ketersediaan capability MTR/iperf3, label partial/unavailable, dan contoh hasil realistis pada runner dokumentasi.

# 17. SARAN URUTAN PENGAMBILAN SCREENSHOT

Urutan berikut mengurangi perubahan state dan membantu menjaga konsistensi data contoh:

1. Siapkan akun contoh approved untuk Viewer, Operator, dan Admin; samarkan data personal. Ambil SHOT-001, SHOT-024, SHOT-025.
2. Login sebagai Admin, pilih data contoh yang tidak memuat secret, lalu ambil SHOT-002–004 dan SHOT-029.
3. Ambil Dashboard/Health yang stabil: SHOT-005, SHOT-026, lalu SHOT-006 hanya dengan Discovery yang memang diizinkan.
4. Siapkan satu Device contoh. Ambil SHOT-007–010 dan SHOT-014.
5. Demonstrasikan perbedaan disable/remove menggunakan konfigurasi contoh, lalu ambil SHOT-011.
6. Dengan dependency sengaja masih ada, ambil SHOT-012; lepas dependency, lalu buka konfirmasi tanpa mengeksekusi delete bila data contoh harus dipertahankan dan ambil SHOT-013.
7. Pada target SNMP contoh tanpa menampilkan secret, ambil SHOT-015–018. Gunakan snapshot stabil untuk SHOT-017.
8. Ambil SHOT-019 sekali dalam framing yang memuat count, search, filter, header sorting, table, dan warning; gunakan callout inset bila teks terlalu kecil saat dicetak.
9. Jalankan Traffic hanya pada runner/capture yang diizinkan; ambil SHOT-020 ketika metrics cukup representatif, lalu hentikan sesuai prosedur.
10. Ambil SHOT-021–023 dari data history/alert yang sudah ada agar timestamp konsisten.
11. Terakhir, jalankan satu Diagnostics yang diizinkan. Ambil SHOT-027 sebelum Run dan SHOT-028 setelah selesai/partial yang representatif.
12. Ulangi hanya SHOT-003 dan satu halaman representatif dalam English bila manual perlu memperlihatkan bukti switching bahasa; tidak perlu menduplikasi semua screenshot.

Sebelum publikasi, periksa setiap gambar untuk password, token, credential profile secret, email personal yang tidak perlu, database ID, atau data jaringan sensitif. Credential profile **reference** boleh dijelaskan, tetapi secret tidak boleh terlihat.

# SOURCE AUDIT SUMMARY

## Frontend files inspected

- Route/action/layout pada `frontend/app`: authentication, dashboard, traffic, history, alerts, devices, snmp, diagnostics, admin, locale resolution, dan protected shell.
- Komponen pada `frontend/components`: app shell/sidebar, dashboard Network Health/Discovery/Reachability/Trends, Traffic, Devices/Health Watch/Device Profile, SNMP target/detail/Observed LAN Hosts, Diagnostics/history, Admin User Access Control, dan language selector.
- Helper/contract pada `frontend/lib`: authorization, i18n, network health, discovery, diagnostics, managed telemetry, observed-host presentation/sorting, dan validation yang relevan.

## Backend files inspected

- Edge Function/action contracts yang mendasari user-visible authorization dan operasi: `network-health`, `network-discovery`, `diagnostic-jobs`, `device-inspector`, `traffic-live`, dan `managed-telemetry`.
- Migration/RPC relevan untuk role/status approval, `network_nodes`, `network_targets`, `managed_telemetry_targets`, latest telemetry, interface, observed hosts, dan dependency/cascade.

## Runner/agent files inspected

- Hanya bagian contract/capability yang diperlukan untuk menjelaskan scope Discovery, Manual Ping, Traffic, Diagnostics, Managed Telemetry, optional tool, serta batas user-visible. Tidak ada runtime state atau credential yang dibaca/disalin.

## Tests used as supporting evidence

- Frontend test suites untuk information architecture, i18n, RBAC, Dashboard/Health, Discovery, Traffic, Devices/Profile, Managed Telemetry, Observed LAN Hosts, Diagnostics, History, dan P8B UX.
- Runner/backend contract tests dipakai hanya sebagai bukti supporting untuk capability, bounds, role-safe action, dan semantics yang tampil pada UI.

## Existing docs used as supporting evidence

- `docs/PRD.md`, `docs/PANDUAN.md`, `docs/HANDOVER.md`, `docs/DESIGN.md`, `docs/PLANNING.md`, serta instruksi `docs/AGENTS.md` dan `frontend/AGENTS.md`.
- Source saat ini menjadi otoritas ketika wording/arsitektur pada dokumen lama berbeda.

## Areas not verifiable from source

- Copy final pada seluruh variasi error provider autentikasi.
- Layout visual aktual pada semua breakpoint dan browser produksi.
- Timezone host/browser produksi.
- Urutan visual toast/dialog untuk seluruh kombinasi dependency.
- Presentasi history setelah target SNMP dihapus.
- Capability optional pada runner yang dipakai khusus untuk screenshot.

## Metrics and confirmation

- **Number of major features audited:** 13
- **Number of Quick Guide workflows documented:** 24
- **Number of screenshots recommended:** 29
- **Number of running-UI verification items:** 6
- **Application source files modified:** none
- Artefak dokumentasi yang dibuat/diubah hanya `docs/manual-book/resources/manual-book-source-audit.md`.
