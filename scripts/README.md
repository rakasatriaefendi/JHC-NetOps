# Project Helper Scripts

Folder ini hanya berisi helper lokal yang masih digunakan. Jalankan dari root
repository dan review dampaknya sebelum eksekusi.

`configure_diagnostic_target.py` mengelola allow-list target pada config runner
lokal. Ia hanya menerima IPv4 private RFC1918 dan tidak menjalankan probe.

```powershell
python scripts\configure_diagnostic_target.py list
python scripts\configure_diagnostic_target.py add --id server-253 --label "Server 253" --ip 192.168.10.253 --port 5201
python scripts\configure_diagnostic_target.py disable server-253
python scripts\configure_diagnostic_target.py enable server-253
```

Restart runner setelah perubahan config melalui mekanisme deployment/runtime yang
direview. Helper verifikasi remote/Edge lama telah dihapus; jangan membuat ulang
jalur compatibility atau deployment remote.

