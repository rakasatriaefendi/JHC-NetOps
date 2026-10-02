# Local Runner

Runner mengorkestrasi job NetOps pada Windows/WSL atau native Ubuntu dan
berkomunikasi hanya dengan Fastify loopback.

## Konfigurasi

- `LOCAL_BACKEND_URL` harus menunjuk loopback backend.
- `LOCAL_BACKEND_TOKEN` adalah bearer token runner dan tidak boleh dicetak.
- `PERSISTENCE_AUTHORITY` harus `local_postgres`.
- `config.local.json`/config production berisi allow-list target dan profil
  credential lokal; file nyata tidak boleh di-commit.

Konfigurasi kosong, parsial, atau authority lain gagal tertutup. Tidak ada remote
fallback atau dual-write.

## Runtime

Runner mempertahankan heartbeat, Health Watch, Traffic, Managed Telemetry,
Discovery, Device Inspector, Manual Ping, dan diagnostics melalui route lokal yang
bounded. Perintah agent tetap terstruktur; browser tidak dapat memasok command,
subnet, OID, timeout, atau capture filter arbitrer.

Windows:

```powershell
npm.cmd ci
npm.cmd test
powershell -ExecutionPolicy Bypass -File task.ps1 status
```

Native Ubuntu memakai launcher `deploy/run-runner.sh` dan config shared yang
direview. Credential SNMP hanya di-resolve di runner dan tidak dikirim ke browser,
database, atau log.
