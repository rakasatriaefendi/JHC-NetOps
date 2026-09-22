# P13 application database cutover runbook

This is a reviewed operator runbook and source-side evidence journal. Nothing in
this directory runs automatically. P13 targets only PostgreSQL
`16/jhcnetops`, port `5433`, database `jhc_netops`. PostgreSQL `16/main`, port
`5432`, `mercure`, and `montblanc` are always out of scope.

The current source is deliberately dormant: `PERSISTENCE_AUTHORITY` must be set
explicitly to `supabase` before cutover. A missing or invalid value fails closed.
Setting it to `local_postgres` fails closed until every local
application repository, legacy mutation guard, and transactional Realtime
shadow projector is installed and the P13 readiness evidence says so. Do not
attempt an authority switch while that guard remains. Supabase Auth and
Realtime remain in place through P13.

## Source preparation

1. Use one immutable candidate release and retain its full commit SHA.
2. Review `docs/P13_APPLICATION_DB_CUTOVER.md`, the accepted P12 Run A/B
   artifacts, and every restricted identity disposition.
3. Confirm no P12 environment variable is present in the P13 operator shell.
4. Review, but do not apply automatically, the prepared production application
   schema at `backend/migrations/007_application_persistence.sql` and the
   transactional outbox/canary schema at `backend/migrations/008_application_persistence_outbox.sql`.
   Both derive from the accepted P12 public schema and leave `asset.*` unchanged.
   The transactional projection outbox and internal cutover canary are required
   source blockers; no operator should execute 007/008 or arm local authority
   until the complete repository/outbox/canary design is reviewed and approved.
5. Run source tests and builds. Do not claim runtime acceptance from them.

## Explicit P13 command contract

All stages use `npm run p13:cutover -- <stage>` from the immutable candidate's
`backend` directory. Every invocation requires all of these explicit values:

```text
P13_PHASE=P13
P13_ACTION=<exact-stage>
P13_EXPECTED_CLUSTER=16/jhcnetops
P13_EXPECTED_PORT=5433
P13_EXPECTED_DATABASE=jhc_netops
P13_EXPECTED_ROLE=jhc_netops_owner|jhc_netops_app
P13_SOURCE_CHECKPOINT_IDENTITY=<64-lowercase-hex-operator-cutover-identity>
P13_OPERATOR_ACK=P13:<exact-stage>:jhc_netops:<same-cutover-identity>
P13_DATABASE_URL=<dedicated-loopback-5433-jhc_netops-DSN>
P13_CUTOVER_RECORD_PATH=<immutable-shared-P13-record-path>
P13_EVIDENCE_PATH=<stage-specific-evidence-path> # except preflight
```

`import-final` is an evidence-journal action and requires the login-capable
`jhc_netops_app` identity, as do `verify-final`, `pre-cutover-verify`,
`postflight`, and `post-cutover-verify`. The journal never logs in as
`jhc_netops_owner`: provisioning intentionally keeps that owner role `NOLOGIN`.
The separately reviewed administrative schema/import transaction still targets
the exact dedicated database and uses `SET ROLE jhc_netops_owner` as designed.
Its bounded import evidence must record
`target.execution_role = jhc_netops_owner`; the journal rejects any other
execution-role claim. Other non-SQL journal stages accept either declared role
only when the role and DSN agree exactly.

The DSN is validated but never written to the record or printed. A P12 variable,
wrong action, wrong checkpoint hash, wrong role, cluster `16/main`, port `5432`,
or any database other than `jhc_netops` blocks the stage. `preflight` creates a
new mode-0600 record and refuses to overwrite an existing record. Later stages
atomically replace only that evidence record. The stage tool does not run SQL,
PM2, Supabase deployment, or migrations: it records independently produced and
reviewed evidence. This separation prevents a single command from becoming an
implicit production cutover.

## Pre-cutover — CHECKPOINT 0

Run `preflight` only after operator review. Retain:

- accepted P12 artifacts and identity dispositions;
- a pre-apply local database dump including `asset.*`;
- source table counts/key hashes;
- runner/agent buffer count and SHA-256 manifests;
- cleanup schedule and writer inventory;
- the current application release and authority configuration.

No writer is stopped at this checkpoint. Supabase is still authoritative and a
release rollback remains separate from database authority rollback.

## Freeze

Enter NetOps application maintenance mode. Freeze registration and profile
administration, prevent new control-plane jobs, disable legacy mutating Edge/RLS
paths, pause Supabase cleanup schedules, stop new runner polling/claims, and let
existing work reach an existing terminal state. Do not invent a migration-only
state transition.

The `freeze-check` evidence must include the same source checkpoint identity and
classify the actual rows as follows:

| Table | Blocks | Safe |
|---|---|---|
| `diagnostic_jobs` | `queued`, `running`, unknown | `completed`, `failed` |
| `traffic_live_sessions` | `queued`, `running`, `stopping`, unknown | `completed`, `failed`, `expired` |
| `network_health_ping_jobs` | `queued`, `running`, unknown | `completed`, `failed` |
| `network_discovery_sessions` | `queued`, `running`, unknown | `idle`, `completed`, `failed`, `expired` |
| `device_inspection_sessions` | `queued`, `running`, unknown | `completed`, `failed`, `expired` |

`diagnostic_runners` is not terminal work: its heartbeat is a continuous writer.
The runner process and heartbeat writer must be paused and the active probe count
must be zero. Existing expiry/recovery paths may finish work before the gate;
the P13 tool never updates or deletes these rows.

Buffer evidence is mandatory for:

- `network-health-state.json` (it has no exact publish-ack watermark, so the
  entire paused file must be an immutable local-replay checkpoint even when
  `pendingTransitions` is empty);
- `snmp-telemetry-state.json` (`pendingEvents` and every `dirty` target must be
  drained, or the paused file must be an immutable local-replay checkpoint);
- `METRICS_BUFFER_PATH` / `metric_buffer` SQLite rows;
- `TRAFFIC_BUFFER_PATH` / `traffic_flow_buffer` SQLite rows.

Each buffer must have its producer paused, a bounded pending count, and a SHA-256.
`drained` requires count zero. A non-empty `checkpointed` buffer is safe only
when its immutable manifest explicitly binds replay to `local_postgres`. Missing
or dirty evidence blocks. The tool never clears or deletes buffer content.

This pre-migration freeze evidence also requires no unresolved identity blocker
and Asset evidence sync disabled. It intentionally does not claim migration
`008` objects, Realtime projector readiness, or a `projection-outbox` buffer:
those do not exist until the reviewed final schema/import has completed.

## Final copy — CHECKPOINT 1

Capture a complete immutable S1 only after the freeze gate passes. Keep all 21
accepted P12 application tables, canonical keys, full content hashes, and a
start/end writer audit. Because REST capture is table-by-table, its logical
consistency comes from proven writer quiescence for the whole window.

Derive S0-to-S1 inserts, full-row replacements, and explicit delete tombstones
by canonical primary key. Never use timestamps alone and never merge ambiguous
identities automatically. The `capture-final` stage hashes the immutable S1
artifact and records that SHA-256 separately from the operator's cutover/checkpoint
identity.

## Import final

Before applying, checkpoint the local `jhc_netops` database including `asset.*`.
There are exactly two supported target states, and the operator must explicitly
choose one; tooling never guesses:

- **`bootstrap`**: Checkpoint 1, Supabase still authoritative, zero local
  authoritative writes, all 21 public application tables absent, migration
  table absent, migration-008 objects absent, and `asset.assets` present. Use
  the reviewed full-S1 command below.
- **`delta`**: all 21 application tables and migration 7 already exist and the
  target has independently passed exact parity against immutable S0. Continue
  with the reviewed S0-to-S1 delta/delete procedure. Finding tables alone is not
  proof of the accepted S0 baseline.

Any partial table set, unexpected migration state, missing `asset.assets`,
bootstrap against populated application tables, or delta against an
empty/unverified target blocks. Neither mode falls back to the other.

For the accepted empty production target, run from the immutable candidate
backend directory with protected DSNs; never put passwords in evidence:

```bash
set -euo pipefail
export P13_IMPORT_MODE=bootstrap
export P13_SOURCE_CHECKPOINT_IDENTITY=70cd9dd18bd2f48e29573cef77bb9bf05e8b1d1e58d5b76aec1122a295d108d9
export P13_EXPECTED_S1_MANIFEST_SHA256=8906f7736cf0f2b7de3820cc911bdb1b8759243f64fff2f61fad4fb979215751
export P13_S1_MANIFEST_PATH=<immutable-evidence-directory>/s1/manifest.json
export P13_CUTOVER_RECORD_PATH=<immutable-shared-P13-record-path>
export P13_IMPORT_EVIDENCE_PATH=<new-import-evidence-path>
P13_NODE=/var/www/jhc/jhc_noc/shared/tools/p13-node-v26.8.2/bin/node
test -x "$P13_NODE"
S1_ACTUAL_SHA=$(sudo -u postgres sha256sum "$P13_S1_MANIFEST_PATH" | awk '{print $1}')
test "$S1_ACTUAL_SHA" = "$P13_EXPECTED_S1_MANIFEST_SHA256"
test ! -e "$P13_IMPORT_EVIDENCE_PATH"
EVIDENCE_DIR=$(dirname -- "$P13_IMPORT_EVIDENCE_PATH")
TMP_EVIDENCE=$(mktemp "$EVIDENCE_DIR/.p13-import.XXXXXX")
chmod 0600 "$TMP_EVIDENCE"
trap 'rm -f -- "$TMP_EVIDENCE"' EXIT HUP INT TERM
sudo -u postgres env \
  P13_IMPORT_MODE="$P13_IMPORT_MODE" \
  P13_SOURCE_CHECKPOINT_IDENTITY="$P13_SOURCE_CHECKPOINT_IDENTITY" \
  P13_EXPECTED_S1_MANIFEST_SHA256="$P13_EXPECTED_S1_MANIFEST_SHA256" \
  P13_S1_MANIFEST_PATH="$P13_S1_MANIFEST_PATH" \
  "$P13_NODE" --import tsx scripts/p13-import-s1.ts \
  < "$P13_CUTOVER_RECORD_PATH" > "$TMP_EVIDENCE"
test -s "$TMP_EVIDENCE"
ln -- "$TMP_EVIDENCE" "$P13_IMPORT_EVIDENCE_PATH"
rm -f -- "$TMP_EVIDENCE"
trap - EXIT HUP INT TERM
```

The manifest must reference exactly `tables/<table>.json` under the same
immutable `s1` root. Each table artifact is the production S1 JSON array, not
P12 JSONL. The importer ignores manifest paths for filesystem resolution and
opens only its fixed 21 allowlisted names beneath that root; a symlink or path
that resolves outside it is rejected. The operator shell streams the protected
cutover record on standard input and captures the bounded JSON evidence on
standard output. A same-directory temporary file plus a no-overwrite hard link
keeps the final evidence name absent until the command has succeeded;
`P13_IMPORT_EVIDENCE_PATH` must not already exist.

The OS `postgres` process needs only the minimum read/traverse ACL required for
the immutable S1 manifest and table artifacts. Do **not** grant `postgres`
traverse or read access to `/home/mini-pc`. After preparing the narrow S1 ACL,
re-read the manifest as `postgres` and require the exact expected SHA-256 before
bootstrap. The cutover record input and output evidence redirections are opened
by the operator shell, so `postgres` needs no filesystem permission for either.

The administrative bootstrap uses only the reviewed dedicated Node v26.8.2
binary at `/var/www/jhc/jhc_noc/shared/tools/p13-node-v26.8.2/bin/node` from the
immutable backend release directory. `npm` is not part of this administrative
runtime. Grant no database login or application secret; retain the generated
mode-0600 evidence for operator review.

The command validates the raw manifest SHA-256, exact 21-table allowlist,
per-table artifact SHA/count/schema/key uniqueness, immutable cutover record,
and exact peer-authenticated `postgres` session over `/var/run/postgresql` to
`16/jhcnetops:5433/jhc_netops` (including exact data-directory verification).
The production migration guards accept a null `inet_server_addr()` only for
this reviewed Unix-socket path. A non-null server address must be loopback, and
the guards still require PostgreSQL 16, database `jhc_netops`, port 5433, exact
data directory `/var/lib/postgresql/16/jhcnetops`, session user `postgres`, and
the existing `asset.assets` relation.
No postgres password or owner-login credential is introduced. Under one
advisory-locked transaction it runs the migration 007 body, `SET ROLE
jhc_netops_owner`, complete S1 inserts in FK order, only the
`network_health_samples.id` sequence reset, then migration 008. Migration 008
is deliberately last, so initial rows do not create shadow outbox events. Any
failure rolls back 007, S1 rows, sequence state, and 008 together.

Before commit it compares every table count, canonical keyset hash, and
normalized full-content hash with S1; requires migration versions `[7,8]`; and
requires an entirely empty outbox (including zero pending/failed rows), zero
watermarks, and zero canaries.
It computes bounded before/after content fingerprints for every `asset` table
and rolls back unless they are identical. Generated DML is restricted to the
fixed `public` application-table allowlist.

The command creates bounded mode-0600 `import-final` JSON evidence containing
the explicit mode/initial state, all 21 table count/hash results, clean outbox
counts, identical asset fingerprints, versions 7/8, and
`target.execution_role = jhc_netops_owner`, `s1_parity = PASS`, and the exact
expected shadow-trigger count.

After the administrative command succeeds, review its new evidence and journal
that same file without changing database state:

```sh
export P13_ACTION=import-final
export P13_EXPECTED_ROLE=jhc_netops_app
export P13_DATABASE_URL=<protected-jhc_netops_app-loopback-5433-jhc_netops-DSN>
export P13_EVIDENCE_PATH="$P13_IMPORT_EVIDENCE_PATH"
export P13_OPERATOR_ACK="P13:import-final:jhc_netops:$P13_SOURCE_CHECKPOINT_IDENTITY"
npm run p13:cutover -- import-final
unset P13_DATABASE_URL
```

For a genuine S0 target, retain the reviewed deterministic delta path: first
prove all 21 target tables exactly match immutable S0, explicitly record mode
`delta` and state `accepted_s0_baseline`, then apply canonical S0-to-S1 changes
and tombstones in dependency order. Reset only the Health sample sequence and
apply/verify migration 008. The new full-S1 command refuses delta mode.
The P12 `asset-baseline.dump` is a local Asset schema/data baseline and is
**not** an application S0 seed; it cannot satisfy the delta precondition.

`import-final` records a bounded PASS report that must name the exact cluster,
port, database, explicit bootstrap/delta mode and validated initial state,
owner execution role (`jhc_netops_owner`), operator checkpoint identity, and
captured S1 hash. The journal invocation itself uses the `jhc_netops_app` DSN
and never substitutes for the actual administrative transaction or executes
SQL.

## Verify — CHECKPOINT 2

Run the complete P12 parity checks plus P13 gates: counts, keysets, hashes,
foreign keys, active rows, Auth logical references, target coverage, buffer
manifests, identity dispositions, and the absence of automatic ambiguous merges.
`verify-final` accepts only a PASS report for the exact target/S1 identity and
then records `CHECKPOINT_2_LOCAL_IMPORTED_VERIFIED`.

## Authority switch — CHECKPOINT 3

Immediately capture fresh post-import authority evidence under the same cutover
identity. Unlike the earlier freeze gate, this gate requires migration `008`
outbox/canary readiness, the `projection-outbox` buffer, the configured and
allowlisted projector, zero failed outbox events, bounded pending-event age,
all local adapters/guards, and all original source-quiescence checks.
`arm-local-authority` advances only from Checkpoint 2 when this new evidence
passes; both the original freeze and authority-time evidence hashes remain
recorded.
The operator may
then make the one reviewed environment/symlink change to
`PERSISTENCE_AUTHORITY=local_postgres` and start the local backend before the
frontend, runner, and agent.

There is no per-operation fallback and no independent dual write. In local mode,
all application reads/writes use local PostgreSQL. A local transaction writes
the domain row and projection outbox item together; only the outbox projector
may update Supabase shadow rows for existing Realtime subscribers. Supabase Auth
continues issuing sessions. Retained Edge mutation handlers must fail closed.

Checkpoint 3 is deliberately recorded before accepting a meaningful local-only
write. That is the narrow simple rollback window.

## Smoke / postflight

Verify local reads, Auth role/status enforcement, one bounded mutation for each
subsystem, heartbeat, job lifecycle, buffer replay, projection/outbox lag, and
Supabase shadow Realtime. Record the count of authoritative local writes in the
`postflight` evidence; do not record payloads or credentials.

Do not touch unrelated processes: `cf-tunnel`, `diva-voice`, `kiosk JHC new`,
and `ollama-server`. Only the reviewed NetOps processes are in scope.

## Rollback window

- Checkpoints 0–2: Supabase is authoritative. Application code can return to the
  accepted release and the pre-apply local checkpoint can be restored under a
  separate reviewed database step.
- Checkpoint 3 with zero accepted local writes: a coordinated configuration /
  release rollback is still simple.
- After any authoritative local write: a symlink or environment rollback is not
  a database authority rollback. Freeze local writers. A reverse switch is
  eligible only after every local change/delete is projected and source/shadow
  parity is reverified. Otherwise reconciliation is required and the default is
  roll-forward repair.

Use `rollback-check` to classify this evidence. It never changes authority or
data. Never promise a blind Supabase fallback after local-only writes.

## Evidence retained after acceptance

Retain S0, S1, the canonical delta/delete manifest, pre-apply local dump,
import/verification reports, identity dispositions, readiness and buffer
manifests, cutover record, postflight report, and outbox watermark. None of
these may contain DSNs, service-role keys, bearer tokens, SNMP credentials, or
raw secret-bearing payloads.

## P13.8 verification contract

`pre-cutover-verify` runs after Checkpoint 2 and before authority can be armed.
Its evidence must prove the exact loopback `16/jhcnetops:5433/jhc_netops`
identity and runtime role, required application/Asset/outbox/canary schema
objects, exact reviewed migration version, passing active-work and buffer
readiness, immutable S1 manifest, completed import, passing final verification,
completed identity dispositions, `PERSISTENCE_AUTHORITY=supabase`, outbox
schema present, projector allowlist valid, and projector configured. Every
missing observation is `UNKNOWN`, not `PASS`. Any `UNKNOWN` or `FAIL` blocks the
stage. A passing report hash is written into the cutover record and is required
before `arm-local-authority` can advance.

Final data evidence is derived from the accepted P12 verification primitives:
table counts and fingerprints, primary/unique keys, foreign keys, sequence
state, latest/history consistency, deterministic representative records, and
logical Auth references. The report contains hashes and statuses only; do not
copy production rows into the report.

`post-cutover-verify` runs only after Checkpoint 3 and postflight. It requires
local application authority, the exact `16/jhcnetops:5433/jhc_netops` database
identity as `jhc_netops_app`, healthy local backend, a fresh online runner
heartbeat whose runtime authority is `local_postgres`, zero active foreground
diagnostics/Traffic/Manual Ping/Discovery/Inspector work, a clean internal cutover
canary through an approved application path (write, read-after-write, cleanup),
a legacy Supabase mutation rejected before network access, Supabase Auth and
shadow Realtime health, zero split-brain indications, the expected immutable
full 40-character Git commit SHA for the intended and current release evidence,
healthy projection outbox (consistent total/delivered/
pending/failed counts, zero failed events, bounded pending count/lag), and a
recent successful projector batch with no current or persistent batch failure.
The authenticated `GET /api/application/outbox/health` response supplies the
bounded counts and projector state without exposing payloads. It also requires
exactly these stable PM2 processes:

- `jhc-netops-backend`
- `jhc-netops-frontend`
- `jhc-netops-runner`

The projection loop is owned by `jhc-netops-backend`; it is not a fourth PM2
process. Backend shutdown stops and awaits the loop before closing PostgreSQL.

The projector allowlist is column-explicit. A rejected unknown aggregate or
malformed key remains `failed`, is never marked delivered, and is not retried as
if it were transient. It continues to block later mutations for that same
aggregate so ordering cannot be falsified; unrelated aggregates remain
processable. Transient network/Supabase failures retain bounded backoff. Safe
projector logs contain only event identifiers, aggregate/operation, bounded
error category/backend code, and bookkeeping stage--never payloads or secrets.

The internal cutover canary uses only `public.cutover_canary`. Its Admin-only
server action writes, reads, verifies, and deletes the bounded row through the
loopback application API; it creates no Asset, Medical Equipment, network,
traffic, health, diagnostic, or telemetry row. Do not substitute a fake
production device, target, medical record, event, or traffic row.

### Final post-deploy closure procedure

First run the existing authenticated Admin cutover-canary action. Retain its
bounded result only when write, read-after-write, verify, and cleanup all pass;
otherwise stop. This is intentionally not replaced by a bearer-token `curl`
because the Admin server action is part of the approved path.

Then collect the remaining observations in one fail-closed subshell. Supply the
approved full Git commit, existing record, and new evidence path. The command
reads only the exact NetOps processes and dedicated application database. It
does not print environment files, tokens, DSNs, or row payloads:

```bash
(
  set -euo pipefail
  set +x

  ROOT=/var/www/jhc/jhc_noc
  INTENDED_SHA="${P13_INTENDED_RELEASE_SHA:?full Git commit required}"
  REL="$ROOT/releases/$INTENDED_SHA"
  NODE=/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node
  RECORD="${P13_CUTOVER_RECORD_PATH:?cutover record required}"
  ARTIFACT_DIR="${P13_POST_CUTOVER_ARTIFACT_DIR:?new artifact directory required}"
  EVIDENCE="$ARTIFACT_DIR/post-cutover-evidence.json"
  CANARY="${P13_CANARY_EVIDENCE_PATH:?Admin canary evidence required}"
  SMOKE="${P13_RUNTIME_SMOKE_EVIDENCE_PATH:?runtime smoke evidence required}"
  BACKEND_URL=http://127.0.0.1:3402

  case "$INTENDED_SHA" in (*[!0-9a-f]*|'') exit 1;; esac
  test "${#INTENDED_SHA}" -eq 40
  test -x "$NODE"
  test "$(readlink -f "$ROOT/current")" = "$(readlink -f "$REL")"
  test -r "$RECORD" && test -r "$CANARY" && test -r "$SMOKE"
  test ! -e "$ARTIFACT_DIR"
  if env | cut -d= -f1 | grep -q '^P12_'; then
    printf '%s\n' 'P13 POST-CUTOVER FAIL: P12 environment contamination' >&2
    exit 1
  fi

  set -a
  . "$ROOT/shared/backend/.env"
  set +a
  test "${PERSISTENCE_AUTHORITY:-}" = local_postgres

  umask 077
  mkdir -- "$ARTIFACT_DIR"
  WORK="$ARTIFACT_DIR/observations"
  mkdir -- "$WORK"
  cd "$REL/backend"
  RUNNER_ID=$("$NODE" -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).runner_id;if(typeof v!=="string"||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(v))process.exit(1);process.stdout.write(v)' "$ROOT/shared/runner/config.json")
  export RUNNER_ID

  pm2 jlist | REL="$REL" INTENDED_SHA="$INTENDED_SHA" "$NODE" -e '
    const fs=require("node:fs"); let text="";
    process.stdin.on("data",chunk=>text+=chunk).on("end",()=>{
      const expected=new Set(["jhc-netops-backend","jhc-netops-runner","jhc-netops-frontend"]);
      const rows=JSON.parse(text).filter(row=>expected.has(row.name));
      if(rows.length!==3 || new Set(rows.map(row=>row.name)).size!==3 ||
         rows.some(row=>row.pm2_env?.status!=="online" || row.pm2_env?.pm_cwd!==process.env.REL ||
           Number(row.pm2_env?.unstable_restarts ?? 0)!==0)) process.exit(1);
      const runner=rows.find(row=>row.name==="jhc-netops-runner");
      const runtimeEnv=fs.readFileSync(`/proc/${runner.pid}/environ`).toString().split("\0");
      const runnerAuthority=runtimeEnv.find(value=>value.startsWith("PERSISTENCE_AUTHORITY="))?.slice(22);
      if(runnerAuthority!=="local_postgres") process.exit(1);
      fs.writeFileSync(process.argv[1],JSON.stringify({release_sha:process.env.INTENDED_SHA,
        runner_authority:runnerAuthority,
        processes:rows.map(row=>({name:row.name,status:row.pm2_env.status,stable:true}))}));
    });' "$WORK/pm2.json"

  curl --fail --silent --show-error "$BACKEND_URL/healthz" > "$WORK/backend.json"
  CURL_CONFIG="$WORK/curl.conf"
  printf 'header = "Authorization: Bearer %s"\n' "$FRONTEND_API_TOKEN" > "$CURL_CONFIG"
  curl --config "$CURL_CONFIG" --fail --silent --show-error \
    "$BACKEND_URL/api/application/outbox/health" > "$WORK/outbox.json"
  rm -f -- "$CURL_CONFIG"

  "$NODE" --input-type=module - "$WORK/database.json" <<'NODE'
import pg from "pg";
import { writeFileSync } from "node:fs";
const pool = new pg.Pool({ connectionString: process.env.APPLICATION_DATABASE_URL, max: 1,
  connectionTimeoutMillis: 3000, statement_timeout: 7000, query_timeout: 8000 });
try {
  const { rows } = await pool.query(`SELECT
    current_database()::text AS database,
    current_setting('port')::int AS port,
    current_user::text AS runtime_role,
    current_setting('data_directory')::text AS data_directory,
    COALESCE(host(inet_server_addr()), 'unix-socket') AS endpoint,
    (SELECT row_to_json(r) FROM (SELECT id,health_status,last_seen_at
      FROM public.diagnostic_runners WHERE id=$1) r) AS runner,
    (SELECT json_build_object(
      'diagnostic_jobs',count(*) FILTER (WHERE kind='diagnostic_jobs'),
      'traffic_live_sessions',count(*) FILTER (WHERE kind='traffic_live_sessions'),
      'network_health_ping_jobs',count(*) FILTER (WHERE kind='network_health_ping_jobs'),
      'network_discovery_sessions',count(*) FILTER (WHERE kind='network_discovery_sessions'),
      'device_inspection_sessions',count(*) FILTER (WHERE kind='device_inspection_sessions'))
     FROM (
       SELECT 'diagnostic_jobs' kind FROM public.diagnostic_jobs WHERE status IN ('queued','running')
       UNION ALL SELECT 'traffic_live_sessions' FROM public.traffic_live_sessions WHERE status IN ('queued','running','stopping')
       UNION ALL SELECT 'network_health_ping_jobs' FROM public.network_health_ping_jobs WHERE status IN ('queued','running')
       UNION ALL SELECT 'network_discovery_sessions' FROM public.network_discovery_sessions WHERE status IN ('queued','running')
       UNION ALL SELECT 'device_inspection_sessions' FROM public.device_inspection_sessions WHERE status IN ('queued','running')
     ) active) AS foreground_work`, [process.env.RUNNER_ID]);
  const row = rows[0];
  if (!row || row.database !== 'jhc_netops' || row.port !== 5433 || row.runtime_role !== 'jhc_netops_app' ||
      row.data_directory !== '/var/lib/postgresql/16/jhcnetops') process.exit(1);
  writeFileSync(process.argv[2], JSON.stringify(row));
} finally { await pool.end(); }
NODE

  printf '%s\n' 'NetOps PM2/release/runner authority evidence:'
  cat "$WORK/pm2.json"
  printf '\n'
  printf '%s\n' 'Dedicated database, runner heartbeat, and active foreground work evidence:'
  cat "$WORK/database.json"
  printf '\n'
  printf '%s\n' 'Outbox totals and projector health evidence:'
  cat "$WORK/outbox.json"
  printf '\n'

  printf '%s\n' 'Recent bounded projector errors (absence is expected):'
  pm2 logs jhc-netops-backend --nostream --lines 200 \
    | grep -E 'SHADOW_PROJECTOR_BATCH_FAILED|SHADOW_PROJECTION_EVENT_FAILED' || true

  # Build post-cutover-evidence.json from the observed files above, the
  # successful Admin canary evidence, and the reviewed browser/runtime smoke
  # evidence. Use the exact P13PostCutoverEvidence field names documented below.
  # Never set PASS merely because a field is missing. Review the JSON before the
  # journal step; the verifier maps missing observations to UNKNOWN and blocks.
  printf '%s\n' 'P13 POST-CUTOVER EVIDENCE READY FOR REVIEW'
)
```

After an operator has reviewed the retained observations and assembled the
exact evidence JSON without defaults, use a second fail-closed subshell for the
journal only:

```bash
(
  set -euo pipefail
  set +x
  ROOT=/var/www/jhc/jhc_noc
  INTENDED_SHA="${P13_INTENDED_RELEASE_SHA:?full Git commit required}"
  REL="$ROOT/releases/$INTENDED_SHA"
  NODE=/home/mini-pc/.nvm/versions/node/v22.23.2/bin/node
  RECORD="${P13_CUTOVER_RECORD_PATH:?cutover record required}"
  EVIDENCE="${P13_POST_CUTOVER_ARTIFACT_DIR:?artifact directory required}/post-cutover-evidence.json"
  test "$(readlink -f "$ROOT/current")" = "$(readlink -f "$REL")"
  test -r "$RECORD" && test -r "$EVIDENCE"
  if env | cut -d= -f1 | grep -q '^P12_'; then
    printf '%s\n' 'P13 POST-CUTOVER FAIL: P12 environment contamination' >&2
    exit 1
  fi
  set -a
  . "$ROOT/shared/backend/.env"
  set +a
  test "${PERSISTENCE_AUTHORITY:-}" = local_postgres

  export P13_PHASE=P13
  export P13_ACTION=post-cutover-verify
  export P13_EXPECTED_CLUSTER=16/jhcnetops
  export P13_EXPECTED_PORT=5433
  export P13_EXPECTED_DATABASE=jhc_netops
  export P13_EXPECTED_ROLE=jhc_netops_app
  export P13_SOURCE_CHECKPOINT_IDENTITY="$("$NODE" -e 'const r=require(process.argv[1]);process.stdout.write(r.source_checkpoint_identity)' "$RECORD")"
  export P13_OPERATOR_ACK="P13:post-cutover-verify:jhc_netops:$P13_SOURCE_CHECKPOINT_IDENTITY"
  export P13_EVIDENCE_PATH="$EVIDENCE"
  export P13_DATABASE_URL="$APPLICATION_DATABASE_URL"

  cd "$REL/backend"
  RESULT=$(npm run --silent p13:cutover -- post-cutover-verify)
  printf '%s\n' "$RESULT"
  printf '%s\n' "$RESULT" | grep -q '"status":"PASS"'
  printf '%s\n' 'P13 POST-CUTOVER PASS'
)
```

The evidence JSON must use the exact `P13PostCutoverEvidence` contract. Map the
database observation to `database_identity` (cluster is `16/jhcnetops` only
when the exact data directory matches), the newest runner row plus PM2 authority
to `runner`, the five query counts and their sum to `foreground_work`, the
authenticated health response to `projection_outbox`, and the exact three PM2
rows to `pm2`. `P13_RUNTIME_SMOKE_EVIDENCE_PATH` must contain the actually
observed local control-plane, legacy-writer rejection, Auth, shadow Realtime,
and split-brain results. The capture command and journal are deliberately
separate so the evidence can be reviewed; there are no fake true/zero defaults.

On any blocked command or verifier result, print `P13 POST-CUTOVER FAIL`, retain
the artifacts, and do not edit the cutover record manually. Never touch
PostgreSQL `16/main`, restart PostgreSQL, modify application rows manually, run
`apt`, reboot, use broad PM2 commands, or touch `cf-tunnel`, `diva-voice`,
`kiosk JHC new`, or `ollama-server`.

In `local_postgres` mode, diagnostic preflight/job creation, Manual Ping queue
creation, Discovery prepare/start, Device Inspector start, and Traffic
create/stop cross a Next server action and the loopback application API before
writing PostgreSQL. These actions have no per-operation Supabase fallback or
dual write. Their source-table writes use migration 008 triggers for the
temporary Realtime shadow; Supabase mode keeps its existing Edge paths.

## Browser and operator smoke contract

Read-only checks after switching authority:

1. Login/session and approved role still resolve through Supabase Auth.
2. Dashboard and adjacent navigation load without session loss.
3. Asset Inventory and Asset Change History load from local application APIs.
4. Medical Equipment and its history views load.
5. Health Watch, Traffic, Diagnostics history, Discovery/Inspector, and Managed
   SNMP workspaces load without starting a probe or poll.
6. Existing Realtime subscriptions receive the controlled shadow projection or
   trigger the expected local refetch; Supabase does not become read authority.

The only controlled write is the dedicated internal cutover canary. It must use
the approved backend application path, prove a local commit, create zero domain
rows, and clean itself up. If it is unavailable or cleanup fails, record
`UNKNOWN`/`FAIL`, accept no substitute production mutation, and stop.

## Rollback and escalation triggers

Stop acceptance and classify rollback when any of these occurs:

- local count, key, fingerprint, FK, sequence, representative, or
  latest/history verification mismatch;
- any migrated application domain cannot be read;
- a write reaches the wrong authority or an old Supabase application writer is
  still active;
- sustained backend/frontend/runner 5xx, crash, or PM2 instability;
- Supabase Auth or required shadow Realtime fails unexpectedly;
- outbox failure, unbounded lag, failed events, or any other split-brain indication.

Before the first accepted local write, application release/configuration
rollback may use the simple pre-authority procedure. After a local authoritative
write, freeze local writers first. A reverse authority switch is allowed only
when every local change is projected and shadow parity is verified; otherwise
data reconciliation and roll-forward repair are required. A release rollback
alone never changes database authority.

## P13.9 exact operator sequence

### 0. Preconditions

Confirm the reviewed source blockers are closed, P12 evidence is accepted,
identity dispositions are complete, disk headroom is adequate, and the operator
has an explicit rollback owner. P13 SOURCE READY must already be `YES`.

### 1. Candidate immutable release

Build and verify one immutable P13 release. Record its full SHA and work only
from `/var/www/jhc/jhc_noc/releases/<P13_SHA>`. Keep `current` on the accepted
release until step 10.

For P13.10 parallel backend runtime validation only, start the immutable
candidate with both:

```text
PERSISTENCE_AUTHORITY=supabase
P13_CANDIDATE_READ_ONLY=true
```

This candidate-only switch is invalid with `local_postgres`. It prevents
Scan Network bootstrap, interrupted Asset Scan recovery, Asset evidence
synchronization, and all non-GET/HEAD/OPTIONS HTTP requests before a repository
handler runs. `/healthz` and required authenticated read paths remain usable.
Do not point the live frontend or runner at this parallel candidate. Normal
live/current behavior uses `P13_CANDIDATE_READ_ONLY=false` or leaves it unset;
the switch is not part of the final authority cutover configuration.

### 2. Backup/checkpoint

Retain S0/P12 evidence and create the reviewed pre-apply checkpoint of only
`16/jhcnetops:5433/jhc_netops`, including `asset.*`. Record its hash and restore
instructions. Do not operate on another cluster or database.

### 3. Preflight

With Supabase still authoritative, collect the guarded target/schema/release
evidence and create Checkpoint 0 using `preflight`. A missing observation blocks.

### 4. Resolve identity gate

Review every conflict, ambiguity, and MAC-only match. Store explicit
keep-separate/map dispositions and retain their immutable manifest hash. Never
perform an automatic ambiguous merge.

### 5. Drain/check active work

Reject new work, allow existing work to reach its normal terminal state, and
collect workflow and buffer evidence. Do not invent terminal statuses or clear
buffers.

### 6. Freeze writers

Freeze registration, profile/inventory mutations, cleanup schedules, legacy
Edge/RLS mutations, runner/agent producers, heartbeats, polls, and probes. Run
`freeze-check`; continue only on `PASS`.

### 7. Final copy/delta

Capture immutable S1 across the complete write-free window, bracket it with
writer audits, and run `capture-final`. Derive the deterministic S0-to-S1
delta/delete manifest only for a target already proven to contain accepted S0;
the exact empty application target uses the full immutable S1 bootstrap.

### 8. Final verification

Inspect the target and explicitly choose the supported `bootstrap` or `delta`
path. Apply the reviewed transaction to the dedicated local database through
the administrative path with `SET ROLE jhc_netops_owner`. Run the non-SQL
`import-final` journal with the `jhc_netops_app` DSN and set
`P13_EVIDENCE_PATH` to the new evidence that names
`target.execution_role = jhc_netops_owner`, then run
`verify-final` and
`pre-cutover-verify`. Continue only with Checkpoint 2 and every check `PASS`.

### 9. Arm local authority

Capture fresh post-import authority readiness evidence (including migration
`008`, outbox/canary, projector, and `projection-outbox` observations), run
`arm-local-authority`, and set the reviewed
candidate environment to `PERSISTENCE_AUTHORITY=local_postgres`. The same
reviewed authority value must be configured for the deployed legacy Edge
mutation guard before writers are unfrozen; Supabase Auth and Realtime remain
unchanged. Do not permit per-operation fallback or independent dual writes.

### 10. Deploy/switch current

Atomically point `current` to the exact immutable P13 release only after
Checkpoint 3 is recorded. This changes the application release, not the database
authority evidence already recorded.

### 11. Restart only exact NetOps PM2 processes

Use only these exact process-scoped commands, in this order:

```sh
pm2 restart jhc-netops-backend
pm2 restart jhc-netops-frontend
pm2 restart jhc-netops-runner
```

Never use `pm2 restart all`, `pm2 stop all`, `pm2 delete all`, `pm2 kill`, a
broad `pkill`, or a global PostgreSQL restart.

### 12. Technical smoke

Verify backend health, local reads, authority diagnostics, legacy-write guards,
outbox health, exact release/PM2 stability, and the internal canary. Run
`postflight`, recording only bounded counts and statuses.

### 13. Browser smoke

Perform the read-only browser checks above. Confirm Auth and shadow Realtime;
do not run network probes or invent production data. Run `post-cutover-verify`
only after every technical and browser observation is complete.

### 14. Observe rollback window

Watch bounded backend errors, PM2 restarts, outbox lag/failures, Realtime, and
split-brain evidence. Re-run `rollback-check` before any reversal. Record the
first accepted local-write boundary.

### 15. Close cutover

Close only when post-cutover verification is `PASS`, retained evidence is
complete, local authority is stable, and the rollback disposition is recorded.
Keep Supabase Auth and required Realtime shadow behavior in place.

## Hard safety boundary

Never touch PostgreSQL `16/main`, port `5432`, `cf-tunnel`, `diva-voice`,
`kiosk JHC new`, or `ollama-server`. Never expose DSNs, passwords, service-role
keys, bearer tokens, Supabase sessions, or SNMP credentials in commands or
evidence.

## P13 acceptance criteria

- **P13 SOURCE READY:** production migrations (007, 008), complete local repositories,
  authority guards, transactional shadow outbox/projector, internal canary,
  verifier tooling, tests, and runbook are reviewed and green. Current status:
  **NO** until the now-implemented Batch 5B local mutation adapters and all
  focused/full source gates are reviewed.
- **P13 RUNTIME READY:** immutable candidate is installed dormant, target/schema
  preflight passes, identities are dispositioned, writers can be frozen, and
  buffers can be drained or checkpointed. Requires Mini PC evidence.
- **P13 CUTOVER PASS:** final import/parity, pre-cutover verification, authority
  switch, technical/browser smoke, post-cutover verification, and observation
  window all pass without split-brain.
- **P13 ROLLBACK REQUIRED:** any explicit rollback trigger fires. Use simple
  rollback only before local writes; otherwise require verified reverse
  projection or reconciliation.
- **P13 DONE LIVE:** actual Mini PC execution completed, retained evidence is
  accepted, local authority is stable, and closure is approved. Source-only work
  can never satisfy this state. Current status: **NO**.
