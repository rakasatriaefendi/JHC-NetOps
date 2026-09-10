# P10D3 Scan Network Settings and routed VLAN support

Date: 2026-09-09. Source implementation is complete; all Mini PC migration,
deployment, real route inspection, and Nmap acceptance remain pending.

## Persistence and bootstrap

Migration `005_scan_network_settings.sql` adds `asset.scan_networks` and the
single-row `asset.scan_network_bootstrap` marker in the dedicated PostgreSQL
`16/jhcnetops` cluster only. A configured row stores a canonical RFC1918 IPv4
CIDR, optional operator label, explicit enabled state, origin
(`manual`/`detected`/`bootstrap`), timestamps, and an optional soft-deletion
timestamp. Live interface, gateway, and route state are derived and never stored.

`ASSET_SCAN_NETWORKS` is now bootstrap/emergency compatibility rather than the
runtime allowlist. On the first initialized startup, its valid bounded entries
are inserted and the durable marker is written in the same locked transaction.
Every later startup leaves database configuration untouched. Disabling or
deleting the last network therefore does not resurrect an old environment value.
Re-adding a soft-deleted CIDR deterministically restores that row.

## Detection, manual fallback, and route tests

The Linux adapter executes only fixed-argument iproute2 operations:

- `ip -j addr show` discovers eligible directly connected private IPv4 networks;
- `ip -j route get REPRESENTATIVE_PRIVATE_IP` classifies one validated CIDR as
  `direct`, `routed`, `unreachable`, or `unknown`.

Connectivity testing is a kernel route lookup, not a ping, sweep, Nmap run, or
claim that a device responded. Adapter absence, malformed output, and unsupported
runtime fail safely to unavailable/unknown. Auto-detection is optional. Manual
LAN configuration is always supported, and the same manual form supports routed
VLAN CIDRs. An unreachable/unknown valid network is saved disabled and can be
enabled only after a current direct/routed result.

The implementation is vendor-neutral. It does not require Ruijie, SNMP, switch
management access, or a particular Linux interface name.

## Scan strategies and safety

Every CIDR is canonicalized, must be wholly within RFC1918 space, and must be
`/22` or narrower (at most 1,024 addresses). At most eight active configured
rows are allowed. Public, loopback, link-local, multicast, IPv6, default routes,
malformed CIDRs, disabled/deleted rows, and arbitrary request CIDRs are rejected.
The browser never supplies Nmap flags or ports.

- Direct Quick Discovery retains fixed ARP-style discovery:
  `nmap -sn -PR --send-ip -T4 -oX - CIDR`.
- Routed Quick Discovery uses fixed bounded IP probes instead of ARP-only:
  `nmap -sn -PE -PS22,80,443 -PA80,443 -T4 --max-retries 1 --host-timeout 3s -oX - CIDR`.
- Deep enrichment retains the existing fixed per-host fingerprint strategy after
  discovery.

## Local API and frontend

The loopback backend adds:

- `GET /api/assets/scan-networks`
- `GET /api/assets/scan-networks/detected`
- `POST /api/assets/scan-networks`
- `PATCH /api/assets/scan-networks/:id`
- `DELETE /api/assets/scan-networks/:id`
- `POST /api/assets/scan-networks/test`

All use the existing server-to-server bearer model and bounded/sanitized errors.
Next.js read actions require an approved profile. Create, edit, enable/disable,
delete, and route-test actions require Operator/Admin. The Asset Inventory now
contains a responsive Scan Networks dialog with detected networks, configured
network cards, manual LAN/VLAN input, route feedback, and an explicit fallback
when detection is unavailable. The existing scan dialog offers only currently
enabled and currently routable configured networks, using their optional labels.

## Mini PC acceptance (pending; operator-run only)

- [ ] Complete and deploy P10D1-B runtime acceptance first.
- [ ] Apply migration 004, then 005, only to cluster `16/jhcnetops`, port 5433,
  database `jhc_netops`; never touch PostgreSQL `16/main`.
- [ ] Verify existing `ASSET_SCAN_NETWORKS` values bootstrap once.
- [ ] Restart backend and prove disabled/deleted rows are not resurrected.
- [ ] Detect the actual Mini PC interface and direct office LAN.
- [ ] If detection fails, manually add the primary LAN and verify full usability.
- [ ] Route-test and run one approved Quick scan on the direct LAN; verify the
  direct helper strategy.
- [ ] Configure one authorized routed VLAN when available, route-test it, and
  verify routed Quick discovery followed by bounded Deep enrichment.
- [ ] Prove disabled/deleted/unconfigured CIDRs cannot be scanned.
- [ ] Verify Indonesian/English, viewer/operator gating, responsive layout, and
  P10D2 scan-linked change history.
- [ ] Run final P10 acceptance. P11 remains frozen until all P10 acceptance passes.
