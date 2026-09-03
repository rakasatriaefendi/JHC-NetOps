# Ubuntu Desktop 24.x Mini-PC Deployment Readiness

This is a P8 readiness audit, not an installation claim. Native Ubuntu support
has not been implemented or validated. The current supported path remains Windows
+ Ubuntu WSL as described in [HANDOVER.md](HANDOVER.md).

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
2. **Native Ubuntu support:** not complete until Linux context and direct process
   adapters are implemented and verified.
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
| Node runner orchestration | Windows Node process; several jobs invoke `wsl.exe`. | B | Add a narrow native process adapter that invokes the existing agent executable directly. Preserve argument lists, timeouts, validation, and error semantics. |
| Adaptive scope resolver | `runner/src/network-scope.mjs` consumes normalized interfaces/routes. | A | Reuse contract and tests unchanged where possible. |
| Network-context collector | PowerShell `Get-Net*` scripts. | B | Implement a Linux provider emitting the same bounded normalized contract. Do not put raw shell control in the browser. |
| Discovery ping engine | Windows `PING.EXE` with fixed arguments. | B | Add a bounded Linux ICMP adapter with equivalent timeout/concurrency/result semantics. |
| Health Watch/manual ping | Windows `PING.EXE`; state/publish logic is Node.js. | B | Retain scheduler/state semantics; isolate only process invocation/parsing. |
| Python agent | Runs in Ubuntu WSL from `agent/.venv`. | A | Recreate a native venv from `pyproject.toml`/`uv.lock`; never copy the WSL venv. |
| SNMP collector | PySNMP in the Linux agent, fixed OIDs and read-only credentials passed by the runner. | A/B | Preserve collector/OIDs/auth/counter/alert semantics; replace only WSL invocation and verify native routing/permissions. |
| Device Inspector | Windows context helper plus WSL agent collectors. | B | Provide Linux route/neighbor/self-interface context and direct agent invocation while preserving authorization/deadlines/evidence. |
| Traffic capture | Runner starts WSL agent as root; Scapy uses a Linux interface. | B | Define least-privilege raw-socket/service permissions and verify native interface selection. Do not broaden capture scope. |
| LAN Diagnostics | WSL agent invokes `iperf3` and MTR. | A/B | Reuse agent parsers; direct-spawn the agent and confirm executable paths/versions on Ubuntu. |
| Local state | Relative `runner/data`, `runner/logs`, and agent buffer paths. | A/D | Choose stable service-owned absolute directories, permissions, backup, and disk policy. Preserve formats unless migration is proven necessary. |
| Startup/autostart | Windows Task Scheduler through `runner/task.ps1`. | C | Design and validate an OS-managed service such as systemd during P8. No unit is supplied by P7. |
| Logging | Runner appends local log; foreground components use process output. | C/D | Decide journald/file retention, rotation, support bundle, and secret redaction. |
| Configuration/secrets | PowerShell env syntax, Windows paths, WSL paths, ignored local files. | D/B | Use Linux environment syntax/paths and service-account permissions; keep the same secret boundary. |

## Main P8 implementation gaps

### Native Linux network context

The Windows collector currently uses `Get-NetAdapter`, `Get-NetIPAddress`,
`Get-NetRoute`, `Get-NetIPConfiguration`, and `Get-NetNeighbor`. P8 needs a native
Linux provider for:

- active interfaces and operational/type metadata;
- IPv4 addresses and actual prefix lengths;
- connected and explicit routes, including the default route as an exclusion;
- neighbor evidence;
- source/default interface identity.

It must emit the existing normalized `scope_inputs` contract consumed by
`runner/src/network-scope.mjs`. A `/23` remains `/23`, a `/16` remains `/16`, and
the resolver continues to bound active Discovery to at most 254 addresses. Tool or
library selection must be made after auditing the actual Mini PC; P7 does not
choose or implement it.

### Native runner-to-agent invocation

P8 must audit `runner/src/wsl.mjs`, `runner/src/main.mjs`, `runner/src/config.mjs`,
the three PowerShell context scripts under `runner/scripts`, and helper launchers
under `scripts`. Replace:

```text
Windows runner -> wsl.exe -> WSL path -> agent executable
```

with:

```text
Ubuntu runner -> native child process -> agent executable
```

The adapter must retain `shell: false`, fixed command selection, structured
arguments, allow-list validation, timeouts, child cleanup, heartbeat independence,
and safe error classification. It must not redesign the working SNMP collector.

### Always-on service

`runner/task.ps1` is Windows-only. P8 should provide and validate a native service
mechanism, expected to be systemd or an equivalent Ubuntu OS service. Its design
must cover automatic boot start, restart on failure, graceful stop, working
directory, environment/config loading, permissions, persistent state, logs,
network-online ordering, and bounded child cleanup. No untested unit file belongs
in P7 documentation.

## Reusable dependency foundation

Reinstall; do not copy runtime directories:

- Node.js 22 is the currently validated line. The project does not yet pin
  `engines`, so P8 must record the exact deployed Node/npm versions.
- Frontend dependencies come from `frontend/package.json` and
  `frontend/package-lock.json`; use `npm ci`.
- Runner scripts come from `runner/package.json`. There are currently no external
  runner npm packages or runner lockfile.
- Python runtime dependencies come from `agent/pyproject.toml` and `agent/uv.lock`;
  use `uv sync --locked` for the locked environment where available.
- Verified Linux executable requirements are Python 3.11+, `ip`, `ping`,
  `iperf3`, and `mtr`; optional TLS evidence uses `openssl`.

On Ubuntu, the corresponding audited package families are `python3`,
`python3-venv`, `python3-pip`, `iproute2`, `iputils-ping`, `iperf3`, `mtr-tiny`,
and `openssl`. Package versions and executable locations must be verified on the
actual Ubuntu 24.x host. Current Windows runner preflight has a WSL-specific exact
path check for `/usr/local/bin/iperf3`; P8 must decide the native path contract
rather than assuming the Ubuntu package location satisfies old WSL code.

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

1. Audit the actual Mini PC and select Linux context/process/service adapters.
2. Implement adapters without changing shared network semantics.
3. Run unit and contract suites before any live operation.
4. Validate context on the authorized current LAN, including non-`/24` prefixes.
5. Validate one bounded Discovery and one known Device Inspector target.
6. Validate Health Watch/manual ping timing and state recovery.
7. Validate one authorized read-only SNMP target without changing credentials/OIDs.
8. Validate bounded Traffic privileges and graceful capture stop.
9. Validate boot, crash restart, power-loss recovery, logs, updates, and rollback.
10. Only then label native Ubuntu and always-on deployment supported.

