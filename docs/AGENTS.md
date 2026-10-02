# AGENTS.md - Active implementation rules

Read `PRD.md`, `DESIGN.md`, and the component README before changing code.

## Current P16 runtime

The active architecture is local-only:

- Local Auth and approved profile/role authorization;
- Fastify bound to loopback;
- dedicated PostgreSQL `16/jhcnetops:5433/jhc_netops`;
- PostgreSQL LISTEN/NOTIFY plus same-origin SSE;
- Local Runner and Python agent through authenticated local backend routes.

Do not add a remote compatibility authority, SDK, Edge transport, fallback, or
dual-write. Historical P12/P13 tooling and all migrations remain immutable
evidence, not active runtime instructions.

## Global safety

1. Never store raw PCAP, packet payload, application content, credentials,
   cookies, tokens, or patient data.
2. Browser code never receives a DSN, backend bearer token, runner credential,
   SNMP secret, or loopback backend URL.
3. Browser actions are structured. Never accept arbitrary commands, targets,
   CIDRs, OIDs, ports, scan flags, capture filters, concurrency, or timeout.
4. Active network work is explicit, role-authorized, allow-listed, bounded, and
   revalidated by the runner/backend.
5. Do not auto-create inventory, auto-promote discovered devices, auto-admin a
   user, infer physical topology, or claim a device is powered off from ICMP.
6. Do not touch PostgreSQL `16/main:5432` or databases owned by other projects.
7. Application startup must not run migrations automatically.
8. Preserve local buffers, retry/backoff, idempotency, and fail-closed behavior.
9. Never log secret-shaped environment, request, or response data.

## Domain boundaries

- Traffic Live is header-only, scoped to This Device, aggregated locally, and
  bounded. It is not capacity testing or whole-LAN visibility.
- Diagnostics (`iperf3`/MTR) are on-demand and separate from Traffic/Health
  baselines. MTR shows responding Layer-3 hops, not every Layer-2 device.
- Discovery derives scope from the runner host, never browser input, and remains
  a bounded on-demand sweep.
- Device Inspector is single-target and fixed-scope. It never becomes a
  vulnerability scanner, credential guesser, or arbitrary port scanner.
- Managed SNMP is read-only, fixed-OID, target allow-listed, and uses local
  credential-profile references. No SNMP SET, arbitrary walk, or secret
  persistence.
- Asset Quick/Deep Scan uses enabled private networks and the reviewed fixed
  helper contract. Network/broadcast addresses and out-of-scope hosts are
  rejected before reconciliation.
- Medical Equipment must not acquire patient/clinical data.
- Realtime is invalidation-only. Clients refetch authoritative PostgreSQL state;
  event payloads never become a second state store.

## Component rules

### agent

Keep protocol parsing and normalization in Python. Preserve Traffic capture/CAP
launcher behavior. Emit only validated structured output. Buffers remain bounded.

### runner

Runner is the orchestration and local allow-list boundary. Use argument arrays,
no shell interpolation, and preserve heartbeat responsiveness. All persistence
uses the local backend bearer route; no fallback.

### backend

Bind loopback only. Keep runner and frontend tokens separate and timing-safe.
Use strict allowlists, bounded bodies/results/deadlines, parameterized SQL, and
transactions where state plus event/history must be atomic.

### frontend

Prefer Server Components/actions for reads and mutations. Client components use
same-origin routes only. Local Auth requires `approved`; role permissions remain
separate. Preserve id/en localization and accessible responsive UI.

### migrations and historical evidence

Normal schema changes use a new reviewed local PostgreSQL migration. Never edit
`backend/migrations/001-015` or `supabase/migrations/**` during P16.3.
P12/P13 runbooks and cutover evidence may mention the retired platform because
they document historical facts.

## Prohibited shortcuts

- disabling validation/tests to make gates pass;
- widening target or payload scope without evidence;
- arbitrary upsert to hide divergent state;
- broad deletes or migration rewrites;
- secret-bearing examples;
- restoring removed remote packages/transports for convenience.
