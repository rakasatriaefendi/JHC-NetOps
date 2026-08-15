# Python Network Monitoring Agent

Agent berjalan di WSL pada perangkat yang terhubung ke jaringan target. Komponen
ini mengumpulkan metrik, menjalankan diagnostics on-demand, dan melakukan bounded
header-only traffic capture.

## Tanggung jawab

- Loop `traffic_metrics` independen dengan interval default 10 detik.
- Health check gateway dan DNS.
- Buffer SQLite lokal ketika Supabase tidak dapat dijangkau.
- `iperf3` dan `mtr` melalui subprocess dengan output JSON.
- Live Traffic berbasis metadata IPv4 TCP/UDP/ICMP tanpa payload atau PCAP.

Bandwidth/path diagnostics tidak masuk ke baseline, severity, atau loop metrik.

## Setup WSL

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
cp .env.example .env
chmod 600 .env
sudo apt install iproute2 iputils-ping iperf3 mtr-tiny
```

Isi minimal `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` pada `.env`. File ini
bersifat lokal dan diabaikan Git.

## Command

Jalankan loop metrik:

```bash
network-monitor monitor
```

Test bandwidth tanpa upload:

```bash
network-monitor bandwidth-test 192.168.1.253 \
  --source-label "IT Office" \
  --target-label "Server 253" \
  --connection-type wifi \
  --no-upload
```

Test path tanpa upload:

```bash
network-monitor path-test 192.168.1.253 \
  --source-label "IT Office" \
  --target-label "Server 253" \
  --connection-type wifi \
  --no-upload
```

Hapus `--no-upload` hanya jika endpoint Supabase sudah siap. Nilai
`--connection-type` wajib `wifi` atau `ethernet`; jangan menyimpulkannya dari nama
interface WSL.

Command `diagnostic-run` dan `traffic-live` adalah interface terstruktur untuk
Windows runner. Penggunaan normal dilakukan melalui UI dan runner, bukan dengan
membuat argument bebas dari browser.

## Test

```bash
source .venv/bin/activate
python -m pip install pytest
python -m pytest
```

## Data yang tidak boleh disimpan

- Packet payload atau application content.
- Raw PCAP.
- URL, credential, cookie, token, atau data pasien.
- Secret pada log atau stdout protocol runner.

Dokumentasi lengkap: [AGENT_SETUP.md](../docs/AGENT_SETUP.md).
