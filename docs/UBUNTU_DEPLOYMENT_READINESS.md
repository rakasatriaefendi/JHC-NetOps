# Ubuntu Desktop 24.x Mini-PC Deployment Readiness

P8A implements the application-level adapters needed for native Ubuntu, while
preserving the Windows + Ubuntu WSL path. The native runtime has been validated
on the Ubuntu 24.04 Mini PC staging host. P8B supplies repository-owned systemd
templates and deployment documentation; installation, enablement, boot recovery,
and rollback validation remain manual follow-up work.

## Target architecture

```text
Ubuntu Desktop 24.x Mini PC
|-- Node.js Local Runner
`-- native Python network-monitor agent
        |-- iperf3 / mtr / Scapy / PySNMP
        `-- optional OpenSSL identity enrichment

Both layers <--> Supabase
Browser / Next.js <--> Supabase
```

There is no WSL layer in this target. macOS is not a deployment target.

Three different readiness statements must not be conflated:

1. **Portable runtime readiness:** adaptive scopes and normalized contracts avoid
   hardcoded office subnets and much application logic is platform-neutral.
2. **Native Ubuntu compatibility:** implemented and staging-validated in P8A
   through Linux context, native process, ICMP, preflight, and relocatable-state
   adapters.
3. **Always-on deployment:** not complete until service, restart, logging,
   persistence, update, rollback, and power-loss behavior are validated on the
   Mini PC.

## Compatibility matrix

Classification: **A** already portable, **B** requires a Linux adapter, **C**
requires Linux startup/service replacement, **D** documentation/config difference.

| Component | Current Windows/WSL implementation | Ubuntu 24.x reuse | P8 action |
|---|---|---|---|
| Next.js frontend | Node.js application using Supabase over HTTPS. | A | Reinstall with `frontend/package.json` + lockfile; choose whether Mini PC hosts it or Vercel remains authoritative. |
| Supabase clients/functions | HTTP/Realtime clients and Deno Edge Functions. | A | Verify outbound HTTPS/DNS and environment values; no platform fork expected. |
| Node runner orchestration | Windows continues to invoke `wsl.exe`; Linux invokes the configured agent executable directly. | A | P8A adapter implemented with fixed argument arrays, `shell: false`, bounded processes, and platform-specific safe errors. Real-host validation remains. |
| Adaptive scope resolver | `runner/src/network-scope.mjs` consumes normalized interfaces/routes. | A | Reuse contract and tests unchanged where possible. |
| Network-context collector | Windows keeps PowerShell `Get-Net*`; Linux uses bounded `ip -j` address/route/neighbor reads. | A | Both emit the same normalized scope contract; the Linux path is staging-validated. |
| Discovery ping engine | Platform adapter uses fixed Windows `PING.EXE` or Linux `ping` arguments. | A | Existing concurrency, timeout, and result semantics are shared. |
| Health Watch/manual ping | Shared scheduler/authorization with the platform ICMP adapter. | A | No Health Watch or manual-ping semantic change. |
| Python agent | Runs in Ubuntu WSL from `agent/.venv`. | A | Recreate a native venv from `pyproject.toml`/`uv.lock`; never copy the WSL venv. |
| SNMP collector | The same PySNMP agent implementation is invoked through WSL on Windows or directly on Linux. | A | P8A changes invocation only; collector/OIDs/auth/counter/alert behavior is frozen. Live authorized Linux validation remains. |
| Device Inspector | Windows context + WSL or Linux route/neighbor context + native agent. | A | Single-target authorization, deadlines, evidence, and normalization remain shared. |
| Traffic capture | WSL root invocation remains on Windows; Linux uses the native agent and configured interface. | B | Architecture path exists; least-privilege raw-socket permission and native interface must be validated later. Missing capability is reported by preflight. |
| LAN Diagnostics | Same agent parsers, native agent spawn on Linux. | B | `iperf3`, MTR, routing, and authorized server behavior require host validation. Missing optional tools do not take down unrelated runner functions. |
| Local state | Runner state/log roots are configurable and may point outside versioned releases. | A/D | Select service-account ownership, retention, backup, and final absolute paths during deployment. |
| Startup/autostart | Windows Task Scheduler through `runner/task.ps1`. | C | P8B supplies reviewed repository templates for systemd; installation and service validation remain manual. |
| Logging | Runner appends local log; foreground components use process output. | C/D | Decide journald/file retention, rotation, support bundle, and secret redaction. |
| Configuration/secrets | One ignored local config supports WSL paths and an absolute native project root; state/log roots are relocatable. | D | Use Linux file permissions and service-account ownership later; the secret boundary is unchanged. |

## P8A native compatibility now implemented

### Native Linux network context

Windows continues to use `Get-NetAdapter`, `Get-NetIPAddress`, `Get-NetRoute`,
`Get-NetIPConfiguration`, and `Get-NetNeighbor`. Native Linux now reads bounded
machine-readable JSON from `ip` for:

- active interfaces and operational/type metadata;
- IPv4 addresses and actual prefix lengths;
- connected and explicit routes, including the default route as an exclusion;
- neighbor evidence;
- source/default interface identity.

It emits the existing normalized `scope_inputs` contract consumed by
`runner/src/network-scope.mjs`. A `/23` remains `/23`, a `/16` remains `/16`, and
the resolver continues to bound active Discovery to at most 254 addresses.
Loopback, inactive links, link-local addresses, and kernel-classified internal
bridges such as a Docker bridge cannot become the primary LAN scope. Selection
uses the eligible interface that owns the default route; no interface name or
address is hardcoded.

### Native runner-to-agent invocation

P8A keeps the Windows path:

```text
Windows runner -> wsl.exe -> WSL path -> agent executable
```

and adds the Linux path:

```text
Ubuntu runner -> native child process -> agent executable
```

The shared runner selects the path explicitly from `process.platform`; other
platforms fail closed. Both use fixed structured arguments, `shell: false`, the
existing allow-list validation, timeouts, child cleanup, heartbeat-independent
async execution, and normalized output. Runtime execution does not use Git and
therefore works from a versioned ZIP release.

Native preflight requires the configured Python runtime and existing agent
capabilities. It reports Linux context, ping, MTR, iperf3, and Traffic readiness
separately. In particular, missing `iperf3` disables active LAN Diagnostics but
does not prevent heartbeat, Health/Discovery where their own dependencies exist,
Device Inspector context, or Managed Telemetry from starting.

### Always-on service

`runner/task.ps1` tetap Windows-only. P8B menyediakan template systemd non-root,
path `current`/`shared`, journald, restart backoff, dan port guard frontend dalam
repository. Template belum dipasang atau diaktifkan pada Mini PC. Prosedur review,
instalasi manual, update, dan rollback ada di
`docs/UBUNTU_ALWAYS_ON_DEPLOYMENT.md`.

## Reusable dependency foundation

Reinstall; do not copy runtime directories:

- Node.js 22 is the currently validated line. The project does not yet pin
  `engines`, so deployment must select Node 22 explicitly through the host's
  existing version manager without changing the system default.
- Frontend dependencies come from `frontend/package.json` and
  `frontend/package-lock.json`; use `npm ci`.
- Runner scripts come from `runner/package.json`. There are currently no external
  runner npm packages or runner lockfile.
- Python runtime dependencies come from `agent/pyproject.toml` and `agent/uv.lock`;
  use `uv sync --locked` for the locked environment where available.
- Core native runner readiness requires Python 3.11+ and the configured agent.
  `ip` enables Linux context, `ping` enables ICMP features, `iperf3` plus MTR
  enable LAN Diagnostics, and Scapy/interface readiness enables Traffic.
  Optional TLS evidence continues to use `openssl` through the existing agent.

On Ubuntu, the corresponding audited package families are `python3`,
`python3-venv`, `python3-pip`, `iproute2`, `iputils-ping`, `iperf3`, `mtr-tiny`,
and `openssl`. Package versions and executable locations must be verified on the
actual Ubuntu 24.x host. Windows keeps its existing WSL-specific exact path check.
Native Linux resolves tools by executable name unless a reviewed local config
override is supplied; it does not install, alias, or change host packages.

## Native configuration and ZIP releases

`runner/config.local.json` remains ignored. On Linux, set
`native_project_root` to the active extracted release (or stable `current`
symlink) and keep `agent_executable` relative to that root. `data_directory` and
`log_directory` may be absolute shared paths outside the immutable release, so a
release switch does not erase runner state or logs. Windows continues to use
`wsl_distro` and `wsl_project_root`; adding Linux fields to the example does not
change the selected Windows path.

No `.git` directory or Git command is needed at runtime. P8A does not create the
planned `/var/www/jhc/jhc_noc` directories, alter other JHC applications, install
packages, or provide a service definition.

Do not introduce `requirements-windows.txt` or `requirements-linux.txt` unless a
real incompatibility is proven. The existing JavaScript and Python manifests are
intended to remain shared.

## Mini-PC operational readiness

Before declaring P8 production-ready, verify:

- Ubuntu Desktop 24.x is installed, patched, and time-synchronized;
- CPU/RAM/storage are sized from measured workload. Until benchmarked, a practical
  planning target is at least four modern CPU cores, 8 GB RAM, and SSD storage,
  but this is not a validated hard minimum;
- stable wired Ethernet is preferred; Wi-Fi behavior must not be assumed identical;
- stable power and planned recovery after power loss;
- outbound DNS/HTTPS to Supabase and routed reachability to each approved target;
- native Node runner and Python agent adapters pass their full non-network tests;
- `iperf3`, MTR, Scapy/raw-socket permissions, PySNMP, and optional OpenSSL are
  verified without broad privileges;
- runner config and SNMP secrets are readable only by the service account;
- automatic startup, restart backoff, heartbeat, graceful shutdown, and child
  cleanup work after boot and failure;
- state/log directories have capacity, retention, rotation, ownership, and backup;
- update procedure records release/commit, runs tests/preflight, and restarts once;
- rollback can restore the previous code release while retaining compatible state;
- encrypted backup/recovery exists for local configuration and credential profiles.

Adaptive Discovery removes fixed-office-subnet assumptions, but it does not create
routes. Managed SNMP and every other target operation still depend on normal Ubuntu
routing, firewall policy, device ACLs, and explicit authorization.

## P8 acceptance sequence

1. Review the P8A adapters and complete the non-network unit/contract gates.
2. Prepare a versioned ZIP release, isolated config, native venv, state, and log
   directories without changing host-wide defaults or existing JHC applications.
3. Run native preflight and record Node/Python/tool capability results.
4. Validate context on the authorized current LAN, including non-`/24` prefixes.
5. Validate one bounded Discovery and one known Device Inspector target.
6. Validate Health Watch/manual ping timing and state recovery.
7. Validate one authorized read-only SNMP target without changing credentials/OIDs.
8. Validate bounded Traffic privileges and graceful capture stop.
9. Validate boot, crash restart, power-loss recovery, logs, updates, and rollback.
10. Only then label native Ubuntu and always-on deployment supported.

