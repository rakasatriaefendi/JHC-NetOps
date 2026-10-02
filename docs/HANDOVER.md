# Technical Handover

## Current authority

JHC NetOps is local-only. PostgreSQL
`16/jhcnetops:5433/jhc_netops` is application persistence authority, Local Auth
is identity/session authority, and LISTEN/NOTIFY plus SSE provides realtime
invalidation. Fastify listens on loopback; the browser reaches it only through
authenticated Next.js server code and same-origin routes.

There is no active remote SDK, REST/RPC transport, Edge Function, shadow
projector, compatibility authority, fallback, or dual-write.

## Process topology

```text
Browser -> Next.js :3401 -> Fastify 127.0.0.1:3402 -> PostgreSQL :5433
                              ^
                              +-- Local Runner -> Python agent

PostgreSQL NOTIFY -> backend LISTEN/SSE -> Next same-origin SSE -> Browser
```

Production launchers are:

- `deploy/run-backend.sh`
- `deploy/run-frontend.sh`
- `deploy/run-runner.sh`
- `deploy/ecosystem.config.cjs`

Use systemd or PM2, never both for the same NetOps processes. Do not change
system Node/NVM defaults and do not manage unrelated senior services.

## Trust boundaries

- Backend: exact loopback bind, exact dedicated DSN guard, separate timing-safe
  runner/frontend bearer tokens.
- Frontend: Local Auth approved profile plus role checks; no secret is public.
- Runner: allow-list, scheduling, host context, and structured process launch.
- Agent: bounded collection/normalization and local buffering.
- PostgreSQL: authoritative state and transactional realtime invalidation.

## Operational invariants

- no raw PCAP, payload, credential, token, or patient data;
- SNMP secrets remain only in ignored runner config;
- active operations require explicit authorization and bounded target scope;
- no application startup migration;
- no access to PostgreSQL `16/main:5432`;
- immutable releases and shared environment/config remain separate;
- symlink rollback does not roll back database schema or data.

## Source of truth

| Runtime | Source |
|---|---|
| Backend | `backend/package.json`, `backend/package-lock.json` |
| Frontend | `frontend/package.json`, `frontend/package-lock.json` |
| Runner | `runner/package.json` |
| Agent | `agent/pyproject.toml`, `agent/uv.lock` |
| Database | reviewed local migrations and `deploy/postgresql` runbooks |

## Historical evidence

`backend/migrations/001-015`, `supabase/migrations/**`, and P12/P13/P15
runbooks are retained to prove migration and cutover history. Their references
to prior authorities are historical and must not be used to configure current
runtime. The retired outbox/watermark rows remain evidence until a separately
reviewed cleanup phase.

Remote project deletion is not part of P16.3. It requires P16.4 acceptance,
backup/evidence confirmation, and explicit operator approval.
