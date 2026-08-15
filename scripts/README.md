# Project Helper Scripts

Script pada folder ini membantu setup dan verifikasi. Jalankan dari root repository
agar semua relative path bekerja dengan benar.

## `start_diagnostics.py`

Memeriksa Scheduled Task, menyalakan Windows Local Runner, lalu menunggu heartbeat
Supabase sampai runner online. Penggunaan paling mudah dari Windows:

```powershell
.\start-diagnostics.ps1
```

Wrapper tersebut memakai virtualenv agent di WSL sehingga tidak bergantung pada
package Python global Windows.

## `configure_diagnostic_target.py`

Mengelola allow-list target LAN pada `runner/config.local.json`. Hanya menerima
IPv4 private RFC1918 dan membuat backup sebelum menulis.

```powershell
python scripts\configure_diagnostic_target.py list

python scripts\configure_diagnostic_target.py add `
  --id server-253 `
  --label "Server 253" `
  --ip 192.168.10.253 `
  --port 5201

python scripts\configure_diagnostic_target.py disable server-253
python scripts\configure_diagnostic_target.py enable server-253
```

Restart runner setelah konfigurasi berubah:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 restart
```

Target harus sudah mendapat izin dan menjalankan `iperf3 -s` pada port yang
didaftarkan. Menambahkan IP ke allow-list tidak otomatis membuat iperf3 server.

## Verification scripts

- `verify_network_discovery.mjs`: pemeriksaan integrasi Network Discovery.
- `verify_dashboard_discovery_browser.mjs`: pemeriksaan browser/dashboard Discovery.

Script verifikasi dapat melakukan request nyata terhadap backend yang dikonfigurasi.
Pastikan memakai environment test yang benar sebelum menjalankannya.

