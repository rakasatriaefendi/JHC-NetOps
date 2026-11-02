# Helper Lokal JHC NetOps

Folder ini berisi helper untuk merawat allowlist target LAN Diagnostics pada
config runner. Helper yang aktif adalah
[configure_diagnostic_target.py](configure_diagnostic_target.py).

## Scope dan prasyarat

Helper membaca/menulis file JSON lokal; ia tidak menjalankan ping, SNMP, Nmap,
iperf3, atau request backend. Gunakan Python 3 dan jalankan contoh di bawah
**dari root repository**.

Allowlist `targets` ini dipakai LAN Diagnostics. Ia bukan daftar
`network_targets` Health Watch, bukan Managed SNMP target, dan bukan inventaris
Asset. Mengubahnya tidak menciptakan row database atau credential.

File default adalah `runner/config.local.json`. Opsi global `--config` harus
ditulis sebelum subcommand untuk memilih file lain.

## Command

```powershell
python scripts/configure_diagnostic_target.py list
python scripts/configure_diagnostic_target.py add --id lab-iperf --label "Lab iperf server" --ip 192.168.10.253 --port 5201
python scripts/configure_diagnostic_target.py disable lab-iperf
python scripts/configure_diagnostic_target.py enable lab-iperf
```

IP di atas hanya contoh. Ganti dengan server private yang memang diotorisasi
dan menyediakan iperf3; jangan menganggap contoh sudah tersedia pada jaringan.

Untuk file konfigurasi lain:

```powershell
python scripts/configure_diagnostic_target.py --config '<PATH_CONFIG_LOKAL>' list
```

| Subcommand | Efek |
| --- | --- |
| `list` | Menampilkan target; tidak menampilkan profil/password SNMP |
| `add` | Menambahkan target enabled setelah validasi; tidak menguji koneksi |
| `disable` | Menandai target disabled tanpa menghapus entry |
| `enable` | Mengaktifkan entry yang sudah ada |

Validasi meliputi IPv4 RFC1918, port 1–65535, ID maksimal 64 karakter, label
bounded, kapasitas maksimal 50 target, serta penolakan ID atau host duplikat.
Target hostname/public IP tidak diterima oleh helper ini.

## Penyimpanan dan keamanan

Perubahan membuat backup `.bak`, menulis file `.tmp`, kemudian mengganti config
secara atomik melalui `os.replace`. Walaupun helper hanya mengubah allowlist,
backup menyalin **seluruh** config dan dapat mengandung credential SNMP.

- Batasi permission config, backup, dan temporary file ke service account.
- Jangan commit, kirim, atau unggah file tersebut sebagai artefak review.
- Review perubahan lokal tanpa mencetak section credential.
- Runner harus direstart melalui prosedur platform yang direview untuk memuat
  config baru. Jangan membuat proses kedua dengan runner ID sama.
- Pesan helper menyebut contoh task Windows; native Ubuntu tetap memakai
  mekanisme service/launcher deployment yang berlaku.

Lihat [runner README](../runner/README.md) untuk perbedaan allowlist, capability,
assignment, dan cara runtime memuat environment. Helper remote/Edge lama bukan
bagian runtime aktif dan tidak perlu dibuat ulang.

