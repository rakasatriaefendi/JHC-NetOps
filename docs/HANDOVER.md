# Technical Handover

This document describes the system implemented in this repository. It is the
practical entry point for a new maintainer. Product requirements remain in
[PRD.md](PRD.md), implementation boundaries in [AGENTS.md](AGENTS.md), and the
current Windows/WSL setup detail in [AGENT_SETUP.md](AGENT_SETUP.md).

## Supported runtime and next milestone

**Validated development runtime:** Windows host, Windows Local Runner, and the
Python agent in Ubuntu WSL.

**Native Ubuntu staging validated:** P8A context/process/ping/preflight adapters
have been validated on the Ubuntu 24.04 Mini PC. P8B adds repository-owned
systemd templates, foreground runner/frontend launchers, a build-only frontend launcher, and
a ZIP-release update/rollback procedure, but those units have not been installed
or enabled. See
[UBUNTU_ALWAYS_ON_DEPLOYMENT.md](UBUNTU_ALWAYS_ON_DEPLOYMENT.md).

## Product mental model

| Area | Responsibility | Important boundary |
|---|---|---|
| Dashboard | Current traffic summary, Health Watch status, Reachability Map, and Operator/Admin Discovery entry point. | A summary surface, not a replacement for Traffic or Diagnostics. |
| Traffic | Bounded, header-only flow visibility for the runner device. | Not the whole LAN, physical topology, or available bandwidth. |
| History | Diagnostic sessions and retained event/history views. | Diagnostic results remain separate from traffic baseline data. |
| Alerts | Active conservative health/telemetry events. | An alert is evidence requiring interpretation, not proof that hardware is broken. |
| LAN Diagnostics | Explicit `iperf3` upload/download and MTR Layer-3 path tests. | Active traffic, authorized targets only; MTR does not reveal every Layer-2 device. |
| Discovery | Operator/Admin-triggered, bounded discovery of hosts visible to the current local runner. | Not continuous monitoring, inventory creation, port scanning, or topology discovery. |
| Devices | One operator inventory with contextual Health Watch configuration. | Inventory identity and detected identity are separate; dependent configuration blocks inventory deletion. |
| SNMP | Latest read-only Managed Telemetry and Observed LAN Hosts first, followed by target configuration. | Known targets and local credential-profile references only. |
| Admin | User approval and account access control. | Monitoring configuration lives on Devices and SNMP, not Admin. |

Role dan status akses adalah dua dimensi terpisah. Viewer memiliki visibilitas
read-only, Operator menjalankan operasi jaringan, dan Admin menambahkan administrasi
user/akses. Hanya status Aktif (`approved`) yang dapat memakai izin role; Menunggu
(`pending`) dan Ditangguhkan (`rejected`) tidak dapat masuk ke area protected.

Untuk native Ubuntu, mental model prosesnya adalah:

- build: `deploy/build-frontend.sh`;
- runtime: `deploy/run-runner.sh`, `deploy/run-frontend.sh`, dan fondasi P9
  `deploy/run-backend.sh`;
- process manager: systemd atau PM2, tidak bersamaan. Jika memilih PM2, hentikan
  service systemd NetOps terlebih dahulu lalu jalankan dari release aktif:

  ```bash
  cd /var/www/jhc/jhc_noc/current
  pm2 start deploy/ecosystem.config.cjs
  ```

  Ecosystem menjalankan tepat tiga aplikasi fork melalui launcher Bash tersebut,
  masing-masing satu instance. Jangan menjalankan npm atau Python sebagai app
  PM2 terpisah, mengubah system Node/default NVM, atau melakukan `pm2 save`
  otomatis.

Backend P9 hanya menyediakan health endpoint lokal di `127.0.0.1:3402`.
Supabase Auth, Realtime, database, dan seluruh Edge Function masih authoritative;
frontend dan runner belum mengirim traffic aplikasi ke backend lokal.

## Current architecture

```text
Browser / Next.js
        |
        v
Supabase Auth + Database + Realtime + Edge Functions
        ^
        |
Local Runner (Node.js)
        |-- Windows: PowerShell context + PING.EXE + wsl.exe --exec
        `-- Linux: ip -j context + ping + native child process
                 |
                 v
          Same Python network-monitor agent
                 `-- iperf3 / mtr / Scapy / PySNMP / optional OpenSSL
```

| Layer | Responsibility |
|---|---|
| Frontend | Authenticated UI, read models, Realtime subscriptions, and structured admin actions. It never runs local shell commands. |
| Supabase | Authentication, RLS, persistent latest state/history, temporary job/session coordination, and validated Edge Function contracts. |
| Local runner | Heartbeat, allow-list enforcement, scheduling, platform context, relocatable local state/logs, and structured WSL/native process orchestration. |
| Python agent | Network measurement, bounded inspection/capture, SNMP collection, and normalized protocol output. |

## Dependency sources of truth

| Runtime | Authoritative files | Reproducible installation |
|---|---|---|
| Frontend | `frontend/package.json` and `frontend/package-lock.json` | From `frontend`: `npm ci`. Use the manifest scripts for dev/test/build/start. |
| Runner | `runner/package.json` | The runner currently has no third-party npm dependencies and no lockfile. Do not create a Python requirements file for it. |
| Python agent | `agent/pyproject.toml` and `agent/uv.lock` | From `agent`: `uv sync --locked` when `uv` is available. `python -m pip install -e .` is the existing compatibility setup but does not reproduce the lock exactly. |
| Supabase | `supabase/migrations`, `supabase/functions`, and `supabase/config.toml` | Apply/deploy through the controlled Supabase workflow; never edit production schema without a matching migration. |

`package.json` does not declare an `engines` range. The repository and current
environment are validated with Node.js 22; the audited workstation used Node
`22.23.2` and npm `10.9.8`. Python requires `>=3.11` in `pyproject.toml`; the
current WSL environment has used Python 3.12. Do not copy `.venv` or
`node_modules` between machines.

## Current setup: Windows + Ubuntu WSL

### 1. Host and repository

Install Git, Node.js 22, WSL2, and the Ubuntu distro named by
`runner/config.local.json`. Clone the repository to a stable path. The current
runner uses Windows paths, WSL mount paths, and `wsl.exe`; keep both path forms
consistent.

### 2. Frontend and Supabase

From `frontend`:

```powershell
Copy-Item .env.example .env.local
npm ci
npm run dev
```

Populate only the variables listed in `frontend/.env.example`. The frontend may
receive the public Supabase URL and anon key, but never a service-role key. Auth,
migrations, and the first admin are covered by [AUTH_SETUP.md](AUTH_SETUP.md).

### 3. Agent inside WSL

Ubuntu system packages used by current code are:

- `python3`, `python3-venv`, and `python3-pip` for the runtime/venv;
- `iproute2` for `ip` route/interface inspection;
- `iputils-ping` for agent-side ICMP checks;
- `iperf3` and `mtr-tiny` for active LAN Diagnostics;
- `openssl` for optional TLS identity enrichment.

Install the Ubuntu packages with `apt` according to the distro package catalog,
then create the environment from the repository rather than copying an old venv:

```bash
sudo apt update
sudo apt install python3 python3-venv python3-pip iproute2 iputils-ping iperf3 mtr-tiny openssl
cd agent
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
cp .env.example .env
chmod 600 .env
network-monitor --help
```

For a lock-reproduced Python environment, use `uv sync --locked` instead of the
pip installation path. The agent test command is `python -m pytest`; pytest is a
test tool and is not currently a runtime dependency in `pyproject.toml`.

Current runner preflight checks a compatible executable specifically at
`/usr/local/bin/iperf3`, `/usr/bin/mtr`, the project venv executable, and Scapy.
An `iperf3` package installed elsewhere on a new distro does not by itself satisfy
that exact current preflight contract. Verify paths with `npm run preflight`; do
not silently change or alias executables without reviewing the runner contract.

### 4. Runner configuration

From the repository root:

```powershell
Copy-Item runner\.env.example runner\.env
Copy-Item runner\config.example.json runner\config.local.json
```

`runner/.env` contains `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
`runner/config.local.json` contains the runner identity, WSL distro/project path,
agent executable, approved diagnostic targets, capture interface, and local SNMP
credential profiles. Use placeholders while preparing it and restrict the file to
the runner OS account. Never print its credential values during troubleshooting.

### 5. Validate and start

From `runner`:

```powershell
npm run preflight
npm run once
npm start
```

For normal background operation, use the existing Task Scheduler wrapper from
the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File runner\task.ps1 install
powershell -ExecutionPolicy Bypass -File runner\task.ps1 start
powershell -ExecutionPolicy Bypass -File runner\task.ps1 status
node runner\scripts\backend-status.mjs
```

The convenience launcher `powershell.exe -NoProfile -ExecutionPolicy Bypass
-File .\start-diagnostics.ps1` installs/starts the task as needed and waits for a
fresh heartbeat. It does not automatically run `iperf3`, MTR, Discovery, or SNMP.

## Startup and shutdown

| Component | Start | Safe stop |
|---|---|---|
| Frontend dev server | `npm run dev` from `frontend` | `Ctrl+C` in its terminal. |
| Frontend production server | `npm run build`, then `npm start` from `frontend` | Stop the owning terminal/process manager gracefully. |
| Foreground runner | `npm start` from `runner` | `Ctrl+C`; allow child cleanup to finish. |
| Scheduled runner | `runner\task.ps1 start` | `Stop-ScheduledTask -TaskName "Network Monitoring Local Runner"`. |
| Runner autostart | `runner\task.ps1 install` | `runner\task.ps1 remove` removes the task; it does not remove config or state. |
| Native Ubuntu runner | `/usr/bin/bash /var/www/jhc/jhc_noc/current/deploy/run-runner.sh` under one process manager | Stop that one owning process manager; the launcher remains foreground and forwards lifecycle through `exec`. |
| Standalone agent monitor | `network-monitor monitor` in the active WSL venv | `Ctrl+C`. Normal structured jobs are started by the runner instead. |

Local runner logs are in `runner/logs/runner.log`. Coalesced Health Watch and
Managed Telemetry state are under `runner/data`. Agent buffers are under
`agent/data` unless overridden by environment. These paths are ignored by Git,
but are operational state and should not be casually deleted during recovery.

## Operational behavior

### Discovery and Device Inspector

Discovery derives the current private scope from the active local interface,
address/prefix, and route information. It does not assume `/24`: the real prefix
is preserved, while a large connected network is reduced to one deterministic
window of at most 254 usable addresses containing the source IP. Default, public,
loopback, link-local, and virtual-internal routes are excluded. The browser cannot
submit CIDR, address ranges, commands, or scan flags.

Windows context comes from `Get-NetAdapter`, `Get-NetIPAddress`, `Get-NetRoute`,
`Get-NetIPConfiguration`, and `Get-NetNeighbor`; Linux context comes from bounded
`ip -j` address, route, and neighbor reads. Both feed the normalized contract in
`runner/src/network-scope.mjs`.

Device Inspector is a bounded single-target operation. The target must be an
active Discovery result or existing inventory node, and the runner revalidates
that authorization. Its purpose is normalized identity/evidence, not arbitrary
scanning. The runner gathers platform route/neighbor context and invokes
`network-monitor device-inspect` through WSL on Windows or directly on Linux.

### Health Watch and manual ping

Health Watch continuously checks explicitly enabled inventory targets with
bounded ICMP from Windows `PING.EXE` or Linux `ping`. It does not discover a subnet. Offline means
repeated lack of ICMP response, which may also result from filtering or path
conditions. Manual PING is an admin-only, one-shot, ephemeral action and does not
overwrite scheduled Health Watch state. Dashboard `Other known targets` dan
Reachability Map memakai provider/request path yang sama, sehingga satu target
tidak dapat dikirim dua kali selama request masih berjalan. Tabel Dashboard
dipaginasi di client sebanyak 10 target per halaman dari dataset Realtime yang
sudah dimuat; tidak ada input IP arbitrary atau query backend pagination baru.

### Traffic

Traffic is a bounded Scapy capture of IPv4 TCP/UDP/ICMP header metadata on the
runner device. It stores normalized flows/snapshots, never packet payload or PCAP.
It cannot prove physical topology or available bandwidth. Windows starts the WSL
agent as root. Linux invokes the native agent with the configured interface
(`auto_ipv4` is supported under its existing constraints), but native raw-socket
permissions remain a P8 host-validation item.

### LAN Diagnostics

Diagnostics are explicit active tests to an approved `iperf3` server plus an MTR
Layer-3 path. Results are isolated from traffic baseline/severity. A server target,
firewall authorization, and normal OS routing must exist before the test can work.

### Managed SNMP Telemetry

Managed Telemetry is read-only and limited to known inventory targets. The browser
stores only a local credential-profile reference. Actual SNMPv2c/v3 values remain
in runner-local configuration. The agent uses fixed allowed SYSTEM-MIB, IF-MIB,
and approved neighbor evidence; there is no SET, credential guessing, or arbitrary
browser-controlled WALK/OID.

Device identity, uptime, interface status, speed, counters, rates, utilization,
errors, and discards are normalized. First samples, resets/reboots, incompatible
interface identity, invalid intervals, and unavailable speed do not produce fake
rates/utilization. Managed target reachability is simply configured management IP
plus normal OS routing; Discovery is not a prerequisite.

Managed Telemetry alerts are conservative:

- interface down requires two consecutive polls while admin state is up;
- interface recovery is emitted after an active down condition returns up;
- high utilization must remain above the critical threshold for the configured
  sustained duration, and recovery requires falling below the warning threshold;
- error/discard events use valid interval deltas on physical interfaces;
- null, invalid, reset/reboot, incompatible, and first-sample values do not create
  counter/rate alerts;
- Managed SNMP polling does not duplicate Health Watch reachability events.

### Observed LAN Hosts

Observed LAN Hosts are latest Layer-3 neighbor evidence from the fixed managed
SNMP neighbor collection. They are not proof of distinct physical devices,
switch-port attachment, or topology. Membership comes from the neighbor evidence;
NetBIOS/NBNS is bounded optional naming enrichment only.

`current` means present in the latest usable observation and `stale` means retained
from an earlier observation. Naming falls back from correlated inventory name to
NetBIOS name and then IP. An all-zero MAC is normalized to `null`/unavailable.
`Partial enrichment` means neighbor membership evidence exists while optional
naming is incomplete for some hosts. It is not automatically an SNMP failure and
may be normal on heterogeneous networks where endpoints ignore NBNS.

## Security boundaries

- Service-role keys stay in runner/agent server-side environment files.
- SNMP secrets stay in `runner/config.local.json`; only profile references reach
  Supabase and the browser.
- The browser never supplies local shell commands, arbitrary OIDs, capture filters,
  CIDRs, or runner executable flags.
- Discovery scope is produced and validated by the local runtime.
- SNMP is read-only and uses fixed collection scope.
- `.env`, `config.local.json`, local state, logs, and packet captures are ignored
  and must not be committed.
- Portable fixtures are returned by a development-only frontend data source and
  cannot publish synthetic Managed Telemetry through the production action.

These boundaries also apply to P8. Removing WSL must not move service credentials
or SNMP secrets into the frontend or cloud database.

## Troubleshooting

| Symptom | Current Windows/WSL check | Interpretation / next safe action |
|---|---|---|
| Runner preflight fails | Run `npm run preflight` in `runner`; inspect the safe code and `runner/logs/runner.log`. | Verify configured distro/path, project venv, exact `iperf3`/MTR paths, Scapy, and local environment. Do not fall back to an arbitrary Python. |
| Supabase/backend unreachable | Run `node runner/scripts/backend-status.mjs`; verify Internet/DNS and the configured project URL without printing keys. | Local coalesced state should remain for retry. Do not manually insert operational rows. |
| Discovery context invalid | Run the fixed context helper only as documented in `AGENT_SETUP.md`; validate structured addresses/prefix/routes. | Windows PowerShell context must serialize to the normalized contract; never replace it with a browser CIDR. |
| Discovery finds fewer hosts | Check interface selection, actual prefix, ICMP policy, neighbor cache, and the 254-host bounded window. | Silent hosts, a large subnet window, or filtering can reduce results. It is not a full inventory scan. |
| Wi-Fi clients cannot see each other | Check AP/client isolation with the network administrator. | Isolation can block lateral ICMP even when Internet access works. Do not weaken scope controls. |
| Managed SNMP timeout/unreachable | Check target enabled state, management IP, OS route/firewall, and device ACL with authorized operators. | Discovery is not required. Do not guess credentials or expand OIDs. |
| SNMP authentication fails | Verify only that target SNMP version matches the named local profile and official IT configuration. | Never print community/auth/priv values. |
| Partial enrichment | Review observed-host status and names. | Neighbor evidence is usable; some optional NetBIOS names were unavailable. This can be normal. |
| Portable fixtures still visible | Remove `PORTABLE_DEV_MODE` and `PORTABLE_DEV_SCENARIO`, then restart the dev server. | Production cannot enable the provider, but a development server retains its startup environment. |
| WSL unavailable | Check `wsl.exe --list --quiet`, configured distro, then restart WSL/runner once if authorized. | Use runner safe errors (`WSL_RUNTIME_FAILED`, readiness timeout, distro/path errors); avoid restart loops. |
| `next-env.d.ts` appears as Git noise | Rebuild and compare the generated file with the branch before editing it. | It is generated by Next.js. Do not discard unrelated user changes or commit accidental mode-only churn. |

Native Linux preflight reports agent, context, ping, MTR, iperf3, and Traffic
capabilities independently. Real-host troubleshooting and service recovery must
still be recorded during P8 validation; Windows commands do not apply to Linux.

## Handover checklist

- [ ] Repository cloned on the intended host; current branch/release recorded.
- [ ] Frontend, runner, and agent environments created from authoritative manifests.
- [ ] Local `.env` and runner config created without committing secrets.
- [ ] Supabase project, RLS, migrations, functions, and authentication reachable.
- [ ] Runner preflight passes and heartbeat is fresh/online.
- [ ] Discovery works on the current authorized LAN and its bounded semantics are understood.
- [ ] One known authorized device can be inspected without arbitrary targeting.
- [ ] Health Watch target/status/recovery behavior is verified.
- [ ] Managed SNMP target uses an official local read-only profile reference.
- [ ] Observed LAN Hosts and Partial enrichment semantics are understood.
- [ ] `PORTABLE_DEV_MODE` is OFF for normal operation.
- [ ] Frontend tests, lint, typecheck, and production build pass.
- [ ] Safe stop/restart and local-state recovery procedure is known.
- [ ] Maintainer understands that Windows + WSL is validated and P8A Linux is
  application-compatible and Mini-PC staging-validated; systemd always-on
  installation and power-loss/rollback validation remain pending.
- [ ] Maintainer has reviewed the remaining Ubuntu P8 deployment gaps before use.
