# P17.2–P17.4 source batch (manual validation pending)

No runtime acceptance is claimed. Migration 017 is additive and must be reviewed
and applied explicitly on `16/jhcnetops:5433/jhc_netops`; no startup migration is
introduced. Migrations 001–016 are immutable.

## Administrative audit

P17.1 DB-backed lifecycle mutations retain their existing transactional
`account_lifecycle_audit` writes, authorization, login-capable last-Admin guard,
pending-only deletion and session revocation. They are not double-written.

The new `administrative_audit` records only Report Branding configuration:
identity, logo upload/replacement, removal. This is the other existing admin-only
configuration surface. Manual Ping and internal canary are operational controls,
not configuration audit events; normal Operator workflows are not recategorized.

Branding remains filesystem-backed (local: existing configured/default branding
directory; production: existing shared branding directory). Its service rechecks
the approved credential-bearing Admin in a DB transaction and serializes audited
writes using a PostgreSQL advisory transaction lock. It detects exact text/byte
no-ops, writes and re-reads the file state, then appends only safe fixed summaries.
Known failures compensate the filesystem while still holding the lock and roll
back the audit. Logo bytes, filename/path and unrestricted request metadata never
enter audit storage. No change is made to filesystem placement or report export.

Filesystem and PostgreSQL are **not** one atomic distributed transaction.
Process death, filesystem compensation failure or an ambiguous DB COMMIT requires
operator reconciliation of file state and audit; do not blindly retry. This batch
does not claim crash-proof cross-store atomicity. All runtime branding writes must
use the audited route; external file edits cannot be audited by this mechanism.

The Admin-only read path rechecks authority in the backend and UNIONs both audit
sources, newest-first with a stable source/id tie-break, 50 rows plus a lookahead,
bounded offset <=10,000. Deleted actors/targets remain represented by UUID. UI
renders only allowlisted human-readable fields, never raw JSON.

## Mutation UX

Native React status/alert notifications reuse existing UI styling; no dependency
is added. Manual-submit configuration forms use synchronous per-form guards,
accessible pending buttons/spinners, preserved input on failure, safe localized
feedback and post-mutation authoritative reads plus Next path revalidation.
Successful no-op lifecycle/branding changes stay silent. Existing typed
`DELETE USER` and network/Health/SNMP confirmations remain independent of feedback.

Traffic start/stop and Discovery start guard same-tick double clicks, always clear
pending and only notify success after local authoritative refetch. Automatic
Discovery preparation and routine SSE/poll refresh do not notify. Discovery has
no existing cancel lifecycle action; closing its drawer remains a UI close, not
an invented scan cancellation. Manual Ping retains its bounded terminal-result
poll and in-flight set; the notification occurs once at the explicit job outcome.
No probe/capture/scheduler behavior or permissions change.

## Web security

Next adds nosniff, DENY, narrowly scoped frame/base/form CSP, strict-origin-when-
cross-origin referrer policy and disables unused device/browser permissions. No
script/style/connect CSP or HTTP-breaking HSTS is introduced. Proxy marks
auth/Admin/API responses private/no-store and rejects foreign/missing Origin on
mutations before application handlers. Framework Server Action CSRF remains on.
Server Action requests are included in the proxy matcher even when their pathname
looks like an excluded static asset. Legacy query-string success notices are
allowlisted and cannot render alongside an error.

Public trust comes only from validated `NEXT_PUBLIC_SITE_URL`. Reviewed direct
entrypoints are `http://192.168.1.130:3401` and loopback frontend :3401; :3000 is
accepted only in development. Arbitrary private/public Host values do not expand
this set. Existing validated public forwarding preserves reverse-proxy behavior.
A future LAN address/port change requires an explicit reviewed trust-policy
update. No shared env or proxy/deployment config is changed.

Local Auth cookies, hashing, opaque sessions, HTTPS-aware Secure/SameSite/HttpOnly,
server-only bearer and loopback backend configuration are unchanged. Backend errors
and notifications do not serialize SQL, paths, tokens or arbitrary exceptions.

## Operator review (not executed here)

Run backend and frontend tests/typecheck/lint/build manually. Review migration 017
grants on an authorized test DB; no DB is accessed by source tests. Check Admin
audit pagination/deleted identity fallbacks, branding no-ops/failed writes and
compensation, concurrent clicks, safe form retention, generic refresh-failure
messages and destructive confirmations. Test public and LAN login/registration,
server actions, branding multipart upload and local SSE under the narrow headers;
verify foreign/missing mutation Origin fails and no token reaches the browser.

If a mutation succeeded but its confirmation read failed, feedback intentionally
reports failure/unconfirmed state. Inspect current authoritative state before
retrying. Do not represent an unavailable read as a successful empty result.
