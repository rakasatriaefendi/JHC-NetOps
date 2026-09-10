# P10D1-B Active Inventory Scan

P10D1-B adds explicit, operator-triggered Nmap enrichment to the existing Asset
Inventory. It is a capability of the loopback Fastify backend, not a second web
application or persistent service. Production ports remain frontend 3401,
backend 3402, and the isolated NetOps PostgreSQL cluster 5433.

## Modes and fixed commands

- Quick Discovery: `nmap -sn -PR --send-ip -T4 -oX - CIDR`.
- Deep host fingerprint: `nmap -Pn -O -sV --version-light --osscan-guess --open -oX - IP`.

The browser supplies only `quick`/`deep` and one network selected from the
server-provided allowlist. Both backend and helper independently reject malformed,
non-canonical, public, loopback, link-local, multicast, and overly broad inputs.
No browser-controlled flags or shell interpolation exist.

## Configuration and availability

P10D3 supersedes the runtime allowlist described in the original P10D1-B scope.
`ASSET_SCAN_NETWORKS` is now a one-time bootstrap list of at most eight RFC1918
IPv4 CIDRs, each limited to 1,024 addresses (`/22` or narrower). Durable
`asset.scan_networks` rows are the runtime authority. If no row is enabled,
`/assets` and retained evidence ingestion continue normally and the UI offers
Scan Network configuration instead of an arbitrary target input. Optional
bounded settings are:

- `ASSET_SCAN_CONCURRENCY` (default 4, maximum 8);
- `ASSET_SCAN_HOST_TIMEOUT_MS` (default 45000);
- `ASSET_SCAN_DISCOVERY_TIMEOUT_MS` (default 120000);
- `ASSET_SCAN_HELPER_PATH` (default `/usr/local/libexec/jhc-netops-asset-scan`).

## Privilege and lifecycle

The backend remains non-root. After review, an operator may run
`deploy/provision-asset-scanner.sh` as root to install the helper root-owned and a
narrow sudoers entry. The helper accepts exactly a mode and target, validates the
target again, and execs `/usr/bin/nmap` with fixed arguments. Do not run this
provisioner on Windows/WSL development machines; fixture executors cover tests
without Nmap.

Only one scan runs at once. Durable metadata is stored in `asset.scan_runs`; raw
XML is not. Cancel sends TERM then bounded KILL fallback. Deep scans continue with
other hosts after an individual timeout/non-zero exit and report failed count.
Backend startup marks an interrupted in-memory scan failed rather than leaving a
false running state.

## Evidence and deferred work

Quick mode stores bounded IP/MAC/vendor/hostname/latency evidence. Deep mode adds
normalized OS confidence, Nmap device type, ports, and service product/version/
extra info. Reconciliation checks current MAC first and then current IP, preserves
operator classification and stronger evidence, and uses the existing bulk upsert.
P10D2 identity history, snapshots and `NEW_DEVICE`/IP/MAC change events remain
deferred, as do P10E and P10F.

## Future Mini PC acceptance (operator-run only)

1. Review migration 003, helper, provisioner, and the exact configured private CIDR.
2. Back up the dedicated `jhc_netops` database; verify the DSN still targets
   `jhc_netops_app@127.0.0.1:5433/jhc_netops`, never PostgreSQL `16/main`.
3. Install Nmap through the approved host change process, then run the reviewed
   provisioner for the non-root NetOps runtime account.
4. Apply migrations through `deploy/postgresql/apply-asset-migration.sql` and set
   `ASSET_SCAN_NETWORKS`; keep concurrency/deadlines at reviewed bounded values.
5. Run backend lint/typecheck/build and frontend lint/typecheck/build, then deploy
   through the existing release process. Do not add a process or listening port.
6. Confirm `/assets` loads and shows scanner availability without starting Nmap;
   confirm Viewer has no start/cancel action.
7. During an approved window, run one Quick scan, verify normalized enrichment
   and absence of duplicate rows, then one bounded Deep scan and cancellation.
8. Verify no orphan Nmap process, no raw XML/secret persistence, no SNMP/Health
   regression, and repeat-scan idempotency. Roll back application release and
   clear `ASSET_SCAN_NETWORKS` if acceptance fails; retain scan metadata for audit.
