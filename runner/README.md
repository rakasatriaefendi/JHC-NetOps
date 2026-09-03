# Windows Local Runner

Runner menghubungkan Supabase dengan tool lokal Windows/WSL. Ia melakukan heartbeat,
mengklaim structured job, memvalidasi allow-list, mengambil konteks route Windows,
menjalankan Network Health Watch, dan mengorkestrasi agent WSL.

Parsing `iperf3`, `mtr`, serta traffic capture tetap menjadi tanggung jawab
`agent/.venv/bin/network-monitor`.

## Batas keamanan

- Target diagnostic selalu di-resolve dari `config.local.json`, bukan dipercaya
  dari payload database/browser.
- WSL dipanggil dengan argument list dan `shell=false`.
- Browser tidak dapat mengirim command, arbitrary flag, interface, atau packet filter.
- Health Watch hanya ICMP ke inventory target yang enabled.
- Network Discovery memakai prefix privat aktual dari context Windows, tanpa
  asumsi `/24`; scope besar dibatasi ke satu window deterministik maksimal 254 host.
- Service-role key tetap berada di `.env` lokal dan tidak dikirim ke UI atau log.

## Setup

1. Salin `config.example.json` menjadi `config.local.json`.
2. Isi distro WSL, project root WSL, source location, interface capture, duration,
   dan target yang sudah diizinkan.
3. Salin `.env.example` menjadi `.env` dan isi credential backend.
4. Pastikan persistent virtualenv agent serta `iperf3`/`mtr` tersedia di WSL.

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
Runner native Ubuntu belum diimplementasikan; gap P8 dijelaskan di
[UBUNTU_DEPLOYMENT_READINESS.md](../docs/UBUNTU_DEPLOYMENT_READINESS.md).
