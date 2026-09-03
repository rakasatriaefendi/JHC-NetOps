# Local Runner (Windows/WSL and native Linux)

Runner menghubungkan Supabase dengan runtime lokal. Windows tetap memakai context
PowerShell dan agent Ubuntu WSL; Linux memakai context `ip -j` dan menjalankan
executable Python agent yang sama secara native.

Parsing `iperf3`, `mtr`, serta traffic capture tetap menjadi tanggung jawab
`agent/.venv/bin/network-monitor`.

## Batas keamanan

- Target diagnostic selalu di-resolve dari `config.local.json`, bukan dipercaya
  dari payload database/browser.
- WSL atau agent native dipanggil dengan argument list dan `shell=false`.
- Browser tidak dapat mengirim command, arbitrary flag, interface, atau packet filter.
- Health Watch hanya ICMP ke inventory target yang enabled.
- Network Discovery memakai prefix privat aktual dari context OS lokal, tanpa
  asumsi `/24`; scope besar dibatasi ke satu window deterministik maksimal 254 host.
- Service-role key tetap berada di `.env` lokal dan tidak dikirim ke UI atau log.

## Setup

1. Salin `config.example.json` menjadi `config.local.json`.
2. Di Windows isi distro dan project root WSL. Di Linux isi absolute
   `native_project_root`. Isi juga source location, interface capture, duration,
   serta target yang sudah diizinkan.
3. Salin `.env.example` menjadi `.env` dan isi credential backend.
4. Pastikan persistent virtualenv agent tersedia. `iperf3`/MTR dibutuhkan untuk
   LAN Diagnostics; jika tidak ada pada Linux, preflight menandai capability itu
   unavailable tanpa mematikan fitur runner lain.

File `.env`, `config.local.json`, data state, SQLite buffer, dan log diabaikan Git.

## Menjalankan runner

```powershell
npm run preflight
npm run once
npm start
```

Untuk auto-start melalui Task Scheduler:

```powershell
powershell -ExecutionPolicy Bypass -File task.ps1 install
powershell -ExecutionPolicy Bypass -File task.ps1 start
powershell -ExecutionPolicy Bypass -File task.ps1 status
powershell -ExecutionPolicy Bypass -File task.ps1 restart
powershell -ExecutionPolicy Bypass -File task.ps1 remove
```

Task berjalan tersembunyi, tanpa execution timeout, dan tidak dihentikan ketika
laptop beralih ke baterai.

## Troubleshooting

Jika UI menunjukkan runner `OFFLINE`:

```powershell
powershell -ExecutionPolicy Bypass -File task.ps1 status
powershell -ExecutionPolicy Bypass -File task.ps1 start
npm run backend:status
```

Log lokal berada di `logs/runner.log` dan tidak masuk Git.

## Test

```powershell
npm test
npm run e2e:localhost
```

`e2e:localhost` hanya regression pipeline. `localhost-demo` harus tetap berlabel
**TEST ENVIRONMENT** dan tidak mewakili performa WiFi, Ethernet, atau LAN.

Tambahkan target LAN nyata hanya setelah alamat, izin pengujian, firewall, dan
server `iperf3 -s` dikonfirmasi. Lihat [PANDUAN.md](../docs/PANDUAN.md).

Setup dan operasi lintas komponen ada di [HANDOVER.md](../docs/HANDOVER.md).
Adapter native Ubuntu P8A sudah diimplementasikan dan diuji dengan fixture, tetapi
belum divalidasi/deploy pada Mini PC dan belum memiliki always-on service. Status
dan langkah penerimaan ada di
[UBUNTU_DEPLOYMENT_READINESS.md](../docs/UBUNTU_DEPLOYMENT_READINESS.md).
