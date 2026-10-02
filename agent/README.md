# Network Monitoring Agent

Agent Python menyediakan collector terstruktur untuk Traffic Live, diagnostics,
Discovery, Device Inspector, dan Managed SNMP. Penggunaan production
diorchestrasi oleh Local Runner.

Traffic Live mengirim snapshot/flow bounded ke backend lokal. Buffer SQLite tetap
menjaga retry/state retention. Capture header-only dan kebutuhan capability Linux
tetap mengikuti launcher/helper yang direview; P16.3 tidak mengubah perilaku
`CAP_NET_RAW`.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
python -m pytest
```

Environment lokal memakai `LOCAL_BACKEND_URL`, `LOCAL_BACKEND_TOKEN`, dan
`PERSISTENCE_AUTHORITY=local_postgres`. Direct remote upload tidak didukung.

Jangan simpan atau keluarkan raw PCAP, packet payload, URL aplikasi, cookie,
token, credential, data pasien, atau raw stdout tool. Target, OID, port, timeout,
dan concurrency harus tetap bounded sesuai kontrak runner.
