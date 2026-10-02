# Native Ubuntu Always-On Deployment

## Runtime

- release aktif: `/var/www/jhc/jhc_noc/current`;
- release immutable: `/var/www/jhc/jhc_noc/releases/<full-commit>`;
- shared backend/frontend/runner environment berada di
  `/var/www/jhc/jhc_noc/shared`;
- PostgreSQL: exact dedicated `16/jhcnetops:5433/jhc_netops`;
- backend: `127.0.0.1:3402`;
- frontend: bind host/port yang direview operator;
- runner/agent memakai config, state, dan log shared di luar release.

Environment aktif harus local-only. Backend dan runner memerlukan
`PERSISTENCE_AUTHORITY=local_postgres`; token runner dan frontend dipisahkan.
Frontend secret tetap server-only. Tidak ada remote fallback.

## Launchers

- `deploy/build-frontend.sh`
- `deploy/run-backend.sh`
- `deploy/run-frontend.sh`
- `deploy/run-runner.sh`
- `deploy/ecosystem.config.cjs`

Gunakan systemd atau PM2, tidak keduanya. Jika memakai jalur PM2, hentikan kedua unit systemd NetOps terlebih dahulu agar tidak terjadi double-start. Ecosystem PM2 menjalankan launcher Bash
di foreground; jangan menjalankan npm/Python sebagai app terpisah atau melakukan
`pm2 save` secara otomatis.

Jalur start PM2 yang direview:

```bash
cd /var/www/jhc/jhc_noc/current
pm2 start deploy/ecosystem.config.cjs
```

Jangan memakai `pm2 start npm`.

Proses PM2 NetOps yang direview adalah jhc-netops-backend, jhc-netops-frontend, dan jhc-netops-runner.
## Candidate dan release

1. Build/test/review pada workstation.
2. Buat artefak dari full commit yang direview.
3. Extract ke direktori release immutable.
4. Jalankan `npm ci` dan buat ulang venv dari manifest/lock; jangan salin
   `node_modules` atau venv.
5. Build frontend dari candidate dengan shared environment.
6. Jalankan acceptance non-network dan preflight read-only yang disetujui.
7. Ubah symlink `current` secara atomik.
8. Restart hanya tiga proses JHC NetOps.
9. Verifikasi health, Local Auth, runner heartbeat, reads/writes, dan SSE.

Candidate backend dapat memakai database yang sama dengan live; karena itu
candidate acceptance harus read-only sampai change window yang secara eksplisit
mengizinkan mutasi.

## Rollback

Rollback aplikasi mengembalikan symlink ke release immutable sebelumnya lalu
merestart hanya proses JHC NetOps. Ia tidak mengembalikan schema/data database.
Pastikan release rollback kompatibel dengan schema yang sudah diterapkan. Tidak
ada authority switch atau fallback remote.

## Batas host

- jangan menyentuh PostgreSQL `16/main:5432`;
- jangan menghentikan/mengubah service proyek senior;
- jangan mencetak environment, token, DSN, atau credential;
- jangan memulai scan/SNMP/capture/diagnostics sebagai bagian dari deployment;
- jangan menghapus historical outbox/watermark atau migration evidence.
