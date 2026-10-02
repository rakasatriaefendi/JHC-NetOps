# Panduan Penggunaan JHC NetOps Monitor

## Akses

Buka origin JHC NetOps yang disediakan operator. Masuk dengan akun lokal. Akun
baru berstatus menunggu sampai Admin menyetujui akses. Viewer membaca data,
Operator dapat menjalankan operasi jaringan yang diizinkan, dan Admin juga
mengelola akses serta konfigurasi.

## Dashboard dan Health Watch

Dashboard menampilkan snapshot Traffic lokal, status target Health Watch, peta
reachability, serta perubahan terakhir. Status offline berarti ICMP tidak
merespons dalam batas yang ditentukan; itu bukan bukti perangkat mati.

Manual Ping hanya tersedia untuk target Health Watch yang sudah dikenal dan
runner yang sehat. Hasilnya sementara dan tidak mengubah status probe terjadwal.

## Traffic Live

Traffic Live hanya melihat metadata header/flow pada interface runner (This
Device). Ia bukan packet inspection, kapasitas link, atau visibilitas seluruh
LAN. Start/stop harus dilakukan secara eksplisit oleh role yang diizinkan.

## LAN Diagnostics

Diagnostics menjalankan pengukuran aktif ke target allow-listed. Pastikan target
dan server `iperf3` telah diotorisasi. MTR menampilkan hop Layer-3 yang merespons,
bukan setiap switch Layer-2. Jangan menjalankan diagnostics untuk sekadar
memeriksa apakah UI hidup.

## Network Discovery dan Device Inspector

Discovery dijalankan on-demand. Scope berasal dari interface/route host runner,
bukan input subnet browser. Hasil tidak otomatis menjadi inventory.

Device Inspector hanya memeriksa satu target terotorisasi dengan collector
bounded. Simpan identity/evidence secara eksplisit setelah ditinjau; hasil
deteksi tidak boleh menimpa identitas operator secara otomatis.

## Managed SNMP

Managed SNMP bersifat read-only. UI hanya memilih target yang dikenal dan
referensi credential profile lokal. Community, username, auth password, dan priv
password tidak pernah dimasukkan ke browser. Observed LAN Hosts adalah evidence
neighbor dari device terkelola, bukan hasil scan bebas.

## Asset Inventory dan Medical Equipment

Asset Inventory menggabungkan evidence yang sudah ada. Quick/Deep scan hanya
untuk network private yang aktif dan sudah dikonfigurasi. Report Excel mengikuti
filter/sort saat ini.

Medical Equipment menyimpan inventaris teknis dan jadwal maintenance/kalibrasi;
jangan memasukkan data pasien atau data klinis.

## Jika data tidak diperbarui

1. Periksa apakah halaman menunjukkan Local Realtime tersambung.
2. Refresh halaman; UI akan refetch state PostgreSQL authoritative.
3. Operator host memeriksa proses backend, frontend, dan runner menggunakan
   process manager yang dipilih.
4. Periksa `/healthz` dan log aman tanpa mencetak token/DSN.
5. Jangan mengubah database secara manual atau mengaktifkan fallback remote.

## Batas keselamatan

- Jangan menjalankan scan, SNMP, ping, MTR, `iperf3`, atau capture tanpa izin.
- Jangan masukkan arbitrary IP/CIDR/credential melalui workaround.
- Jangan simpan raw PCAP, payload, token, credential, atau data pasien.
- Jangan menyentuh PostgreSQL `16/main:5432`.
