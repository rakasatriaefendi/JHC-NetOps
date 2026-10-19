# P18: on-demand monitoring and runner control

Status: source implementation and local fixture verification, **not production
acceptance**. No production service, database, credential or deployment was changed.

## Architecture and ownership

P17-D4A used a 60-second HTTP work wait plus independent HTTP heartbeat and
Health/SNMP assignment refresh. P18 retains those routes for compatibility, but
a healthy upgraded runner uses one authenticated loopback WebSocket instead.

PostgreSQL remains the only durable job authority. The socket carries health,
monitoring policy and work-kind invalidations, never executable commands or job
assignments. The unchanged atomic HTTP claims/results still enforce target,
runner, session, capability, lease and authorization constraints. Priority remains
Manual Ping, Traffic, Discovery, Device Inspector. Accepted agent work remains
serial and bounded; Traffic snapshot/stop handling and CAP_NET_RAW are unchanged.

Exactly one Fastify backend process owns presence and runner sockets. This is the
existing fork deployment model, not a distributed-presence implementation. Do not
scale backend workers without a reviewed cross-process presence design. Queue
recovery does not depend on that process-local presence or on volatile hints.

## Protocol and security

- Upgrade `GET /api/runner/control`, only loopback peers, exact path, no browser
  Origin, existing timing-safe runner bearer header. No URL token or public proxy.
- Maximum 32 sockets including unfinished handshakes; one reserved ID per runner.
  Initial application health must validate/persist before readiness. Registration
  uses the existing shared runner credential trust model, not per-runner keys.
- Text JSON only, 32 KiB inbound server / 4 KiB inbound runner, no compression.
  Server admission is 12 application messages/second/socket; queue reads coalesce
  to at most one per 100 ms. Slow senders/receivers are bounded by 64 KiB buffered
  output. Schema/identity errors close the channel, without raw-frame logging.
- Runner -> backend: `{type:"health",runner:<existing validated heartbeat>,
  ready:boolean,busy:boolean,policy_revision:number}` every 30 seconds (legacy timer calls coalesce),
  and `{type:"reconcile"}` after accepted work finishes.
- Backend -> runner: `{type:"work_available",available:[<allowlisted kinds>]}`;
  `{type:"ready"|"runtime",state,monitoring:boolean,control:"websocket"|"degraded",policy_revision:number}`.
  These messages contain no credentials, row data, targets, flags or commands.
  Policy changes invalidate old readiness: ACTIVE requires a fresh runner health
  report acknowledging the exact current policy revision, including after a rapid
  leave/return race. The revision is process-local and reconciled anew on reconnect.
  STANDBY likewise requires acknowledgement of the pause revision and no reported
  pending buffer/work; until then the backend truthfully reports DRAINING.
- Ping/pong and durable reconciliation every 10 seconds. Missing pong terminates
  the connection; missing application health >90 seconds also terminates it.
  Existing PostgreSQL heartbeat freshness/offline tolerance stays 120 seconds.
  A TCP connection or pong alone never persists online health.
- Persistence calls reuse the bounded three-second logical deadline. Existing
  pool/statement deadlines still bound underlying rollback/client cleanup; abort
  is not claimed to force immediate PostgreSQL wire cancellation.
- Subscribe before initial durable read, revision/trailing check on enqueue races,
  post-commit hints from all reviewed application enqueue routes. Bypass writers,
  lost responses and missed hints are recovered by internal reads within 10
  seconds plus query latency, not periodic healthy HTTP. Atomic claims remain
  authoritative even with duplicates, stale hints or a legacy runner competing.
- Reconnect uses jittered exponential backoff, about 0.8-1.2 seconds initially,
  capped at 30 seconds. Socket/heartbeat/work timers clean up on shutdown.

## Presence and runtime policy

The protected layout owns one visible-tab EventSource at
`/api/realtime/presence`. Login/pending pages do not create presence. Hidden tabs
release it; each visible approved tab/user has an independent backend handle.
Backgrounding or minimizing the last visible dashboard can therefore pause
monitoring after grace even when its user remains logged in. Returning to a
visible authenticated tab resumes the existing enabled targets automatically.
Next authenticates Local Auth and forwards the HttpOnly session only server-side
to `/api/application/presence`, with the separate frontend bearer. Browser-supplied
user IDs are not accepted. Backend independently checks the canonical approved
profile and unexpired session digest, revalidates every 15 seconds, and closes at
the original expiry deadline. Logout/disable/revocation is detected by the next
check (plus bounded read deadline); disconnect and shutdown release handles.
Stream capacity is 128, with no per-second HTTP presence requests. Reconnect uses
bounded 1-30 second backoff and stops while hidden/unmounted. Existing browser
invalidation SSE and P17-D2A Traffic refresh logic are unchanged.

`MONITORING_STANDBY_GRACE_MS` defaults to 30000; valid 0-300000. It is optional
and does not require changing shared production env. After last visible presence
leaves, monitoring remains active for the grace period; policy reaches the runner
on state publication/the next 10-second reconciliation.

| State | Meaning |
| --- | --- |
| STANDBY | No presence/grace, no known protected work or pending monitoring buffer |
| ACTIVATING | Presence/grace active, runner reloading assignments/draining prior buffers |
| ACTIVE | Presence/grace active, connected runner reports monitoring ready |
| DRAINING | No presence/grace, accepted work or monitoring results still need completion |
| DEGRADED | No upgraded control connection, or durable work evidence unavailable |

Monitoring policy and manual-work lifecycle are separate. Manual accepted work is
claimed/completed without requiring presence. DRAINING stops new scheduled probes,
not accepted Traffic/Discovery/Inspector/Ping or pending-result publication.
Unknown queue state is never interpreted as an empty queue. Busy evidence includes
all existing interactive queue tables and the backend's active manual Asset scan.

Health/SNMP watches start paused, including with enabled cached targets. Pausing
retains targets, intervals, credentials, counters, latest observations and pending
transitions/results; in-flight probes finish and dirty buffers flush with existing
backoff. A clean paused watch makes no assignment/publish HTTP or device probe.
Persistent publication failures remain DRAINING/retrying, not successful zero-idle.
On activation, assignments reload before new work (including newly enabled or
disabled assignments), pending authorized results flush, and initial due times
are staggered (Health 250 ms/target, SNMP 500 ms/target) within existing concurrency
bounds. Existing active target intervals, including 1800 seconds, remain intact.

The first post-pause observation establishes fresh Health short-window / SNMP
counter and alert-continuity baselines. The unobserved gap cannot manufacture
continuous utilization, down/recovery or counter-delta evidence. Existing pending
events are retained; a pause itself never emits offline events. Historical rows
are not rewritten. **Incidents during standby cannot be detected until monitoring
resumes.** The localized global banner distinguishes active, paused/resuming and
degraded control; last-observation timestamps remain on the existing measurements.
ACTIVE means schedules enabled, not that every measurement is instantaneous.

Asset evidence sync runs on explicit inventory/report reads (bounded, no background
timer). Quick/Deep Scan is an explicit authorized action, never run on login.
No asset data cleanup, identity change or automatic scanner was introduced.

## Remaining activity / degraded fallback

Healthy stable standby: zero periodic work-wait, heartbeat, Health assignment or
SNMP assignment HTTP. Startup upgrade, accepted mutations/claims/results and active
monitoring legitimately use HTTP. No browser requests exist with all clients closed.
Open browser features retain existing independent SSE/refetch behavior; hidden
tabs suspend shared local invalidation streams and fallback reads, Discovery
runner/session refresh, active Asset Scan UI polling, and Diagnostics preflight
refresh. Visible tabs reconcile
authoritative state on return. Accepted jobs continue in the backend/runner.

WebSocket frames, local scheduler ticks, heartbeat DB writes, bounded queue reads
and 10-second independent expiry maintenance remain. This is **not zero network,
CPU or database activity**. Presence revalidation adds DB reads only while its
streams exist. Old page-specific subscriptions are not counted as presence.

On socket failure, HTTP work-wait/heartbeat fallback continues with existing error
backoff and truthful DEGRADED reporting. It is not zero-idle. Only an explicitly
missing socket endpoint (404/405) enables legacy monitoring behavior; other socket
failures leave monitoring paused until authenticated policy returns. Old HTTP
claims, wait compatibility negotiation and lease recovery remain intact.

## Dependencies, schema and rollout (instructions only)

No migration/schema changes. Backend and runner add exact `ws@8.22.0`; backend adds
`@types/ws@8.18.2` in the lockfile. Runner now has its own lockfile and **must have
its dependencies installed in the immutable candidate**; it is no longer a
dependency-free Node script. No Python/CAP/agent, Cloudflare or PM2 change.

For a later reviewed release: install using `npm ci` in backend, frontend **and
runner**. Roll out backend first (old runner continues HTTP), then frontend presence,
then upgraded runner. Do not deploy upgraded runner before presence-enabled frontend:
it deliberately stays paused without authenticated presence. Verify one backend
process, no new public WS proxy, no credentials in browser bundles/logs. Never
modify an immutable/live release in place.
Any later PM2 restart must name only `jhc-netops-backend`,
`jhc-netops-frontend`, or `jhc-netops-runner` for its reviewed step; never
restart the whole PM2 process set or unrelated services.

Rollback the runner to accepted P17-D4A first, then frontend/backend as needed.
Old HTTP endpoints/schema remain compatible; rollback requires no data rewrite or
migration. Old runner restores its previous unattended monitoring policy, so this
is an explicit operational policy rollback, not zero-idle.

## Local verification commands (no live config loaded)

```powershell
npm.cmd --prefix backend test
npm.cmd --prefix backend run typecheck
npm.cmd --prefix backend run lint
npm.cmd --prefix backend run build
npm.cmd --prefix runner test
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run typecheck
npm.cmd --prefix frontend run lint
npm.cmd --prefix frontend run build
Push-Location backend
node --import tsx scripts/p18-recovery-drills.mjs
node --import tsx scripts/p18-standby-soak.mjs
Pop-Location
git diff --check
```

Recovery drills use real loopback sockets and fake persistence/claim/agent
boundaries. They exercise pre-connect enqueue, committed wake, priority, duplicate
hints, disconnect, database failure simulation and backend restart with retained
fixture queue. The soak runs actual timers for >=300000 ms, one real control socket,
actual watch/control/heartbeat loops and enabled cached fixture targets, counting
HTTP, probes, ping/pong, CPU/memory and repository calls. It rejects host suspension
or event-loop gaps >=5 seconds and insufficient keepalive activity. Repository call
counts are **not measured PostgreSQL queries**. No real SNMP/ping/capture is run.

Required production acceptance remains: real dedicated PG query/lease recovery;
approved visible presence across tabs/users, logout/expiry/crash; enabled Health
and SNMP ACTIVE -> grace -> DRAINING -> STANDBY -> resume; retained failed publish;
new/disabled assignments; real Ping latency, Traffic RX/TX/packets/flows, Discovery
and Inspector; six-minute access-log/device-probe measurement with all browsers
closed after drain; intentional fallback/disconnect/restart separately. Do not
declare production readiness from fixture soak or builds alone.

## Recorded local verification

Local Windows / Node 24.21.0, final source review:

| Gate | Result |
| --- | --- |
| Full backend tests | 407/407 PASS after busy-evidence and keepalive hardening |
| Full runner tests | 203 PASS, 1 existing platform skip, 0 failures (204 total) |
| Full frontend tests | 291/291 PASS after paused-state and hidden-tab hardening |
| Backend typecheck / lint / build | PASS |
| Frontend typecheck / build | PASS |
| Frontend lint | 0 errors; existing `network-discovery.ts:28` unused `_fallback` warning retained |
| Modified runner syntax checks | PASS |
| Local recovery drill | PASS, ten fixture executions, no completed-job replay |
| Isolated PostgreSQL 16 integration | BLOCKED locally: no safe PostgreSQL 16 instance (Docker daemon unavailable; installed Windows service is PostgreSQL 17 and unrelated) |
| Live device / browser acceptance | NOT RUN |
| Python collector/CAP runtime acceptance | NOT RUN; no agent/provisioning source changes |

Final continuous real-socket fixture soak: **300015.524 ms**, **0 HTTP requests**,
**0 device probes**, **1 actual loopback connection** (`getConnections`),
29 ping / 29 pong frames. Largest event-loop sampling gap: 1036.3514 ms.
Process CPU: 203 ms user + 47 ms system; final RSS 81702912 bytes (~77.9 MiB).
These measurements combine fake backend/runner boundaries in one local process,
not separate production services or Mini PC resource benchmarks.

Fake repository method counters: available 39, recovery 30, busy 30, heartbeat 10.
They include initial setup and are not PostgreSQL query/round-trip measurements.
Work-wait, HTTP heartbeat, Health/SNMP assignment HTTP were all zero during the
stable window. All browser clients were absent; this is not a real browser soak.
No production database or device was contacted.

The latest local drill measured committed Ping hint-to-fixture-execution at
22.75 ms; ordered four-kind fixture dispatches at roughly 105/211/315/421 ms;
backend restart-to-retained-fixture execution ~866 ms; cold runner restart ~13 ms.
These are real loopback transport timings with fake persistence/claims/agents,
**not actual ICMP latency, scan duration, capture throughput or production SLA**.
Actual Traffic RX/TX/packets/flows and live Discovery/Inspector/SNMP remain for
authorized runtime acceptance.

Earlier validation caught a coincident-heartbeat frame burst (fixed by coalescing),
and a post-job queue refresh delay (fixed by explicit bounded reconcile hints).
One elapsed-time soak was invalidated by host suspension; it is not used as
acceptance. The final continuity-checked run above passed after these repairs.
