# P12 Rehearsal Operator Runbook

> **Historical accepted P12 runbook:** commands refer to the immutable P12 release and are not exposed by the current package manifest. Do not execute them from the P16 local-only release.


This tooling is only for an approved P12 dry run. It does not change application
persistence authority. Never use PostgreSQL `16/main`, port `5432`, or database
`jhc_netops` as the rehearsal target.

Generated artifacts live outside releases and `current`:

```text
/var/www/jhc/jhc_noc/shared/p12/<run_id>/
```

They can contain production identity and encrypted opaque legacy values. Keep the
directory restricted, do not web-serve it, and never commit or print its contents.

## Required protected environment names

Only names are documented here:

- `P12_RUN_ID`
- `P12_ARTIFACT_ROOT`
- `P12_SOURCE_COMMIT`
- `P12_REHEARSAL_LABEL` (`a` or `b`)
- `P12_REHEARSAL_DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

`P12_REHEARSAL_DATABASE_URL` has no `DATABASE_URL` fallback. It must identify the
exact `jhc_netops_p12_<run_id>` database on loopback port `5433`.

## Explicit operator sequence

Run the rehearsal from the immutable candidate release without changing the
`current` symlink. P12 is a non-cutover rehearsal: leave
`jhc-netops-backend`, `jhc-netops-frontend`, and `jhc-netops-runner` running,
leave Supabase as the persistence authority, and leave Realtime and Auth
unchanged. No PM2 stop or restart is required for P12. Never touch unrelated
processes `cf-tunnel`, `diva-voice`, `kiosk JHC new`, or `ollama-server`. Do not
stop or restart `postgresql@16-main`.

```bash
ROOT=/var/www/jhc/jhc_noc
# Accepted P12 example; replace both values for a later immutable candidate.
RELEASE_SHA=ee1716c
SOURCE_COMMIT=ee1716c3462c3efafda320c223dc46911b9dcd0b
[[ "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || {
  printf 'P12 source commit must be exactly 40 hexadecimal characters.\n' >&2
  exit 1
}
REL="$ROOT/releases/$RELEASE_SHA"
RUN_ID=20260914b
DB="jhc_netops_p12_$RUN_ID"

cd "$REL"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh prepare "$RUN_ID"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh clone-baseline "$RUN_ID"
```

Load protected backend variables without printing them, then capture the immutable,
GET-only Supabase REST snapshot:

```bash
cd "$REL/backend"
set -a
. "$ROOT/shared/backend/.env"
set +a
export P12_RUN_ID="$RUN_ID"
export P12_ARTIFACT_ROOT="$ROOT/shared/p12"
export P12_SOURCE_COMMIT="$SOURCE_COMMIT"
npm run p12:snapshot
unset SUPABASE_SERVICE_ROLE_KEY
```

`RELEASE_SHA` identifies the immutable release directory and may be abbreviated.
`SOURCE_COMMIT` is the full 40-character Git identity recorded in the snapshot
manifest. Never populate `P12_SOURCE_COMMIT` from `RELEASE_SHA`.

The snapshot is intentionally non-atomic across tables and is acceptable only for
P12 rehearsal. The manifest records the capture start/end window and per-table
counts and fingerprints; a row-count change while a table is paginated fails the
capture. Because live writes continue, any remaining cross-table drift risk and
the non-atomic warning must be retained and reported as P12 evidence. P13 owns the
atomic, quiesced, or checkpointed final cutover strategy.

Apply the isolated schema, then import using an independently supplied rehearsal
URL. Never derive it from `DATABASE_URL`:

```bash
cd "$REL"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh apply-schema "$RUN_ID"

cd "$REL/backend"
export P12_REHEARSAL_DATABASE_URL='postgresql://<approved-role>:<protected-password>@127.0.0.1:5433/'"$DB"
npm run p12:import
```

## Verification, reconciliation, and repeatability

An import alone is never acceptance. Run A and Run B must use the exact same
immutable `source-snapshot/` files and `local-baseline/asset-baseline.dump`. The
baseline wrapper records and verifies `manifest/local-baseline.sha256` before each
restore. The first `clone-baseline` call captures the local baseline only when the
dump does not yet exist. Every later call, including Run B, reuses that existing
dump and fails if its SHA-256 no longer matches the manifest; it does not create a
new dump from the then-current live `jhc_netops`. Do not remove, replace, or edit
either baseline artifact between runs.

Complete Run A while the first fresh rehearsal database still exists:

```bash
cd "$REL/backend"
export P12_REHEARSAL_LABEL=a
npm run p12:verify
npm run p12:reconcile
unset P12_REHEARSAL_LABEL P12_REHEARSAL_DATABASE_URL
```

Destroy only database A, retain the immutable source snapshot and local baseline,
then create a fresh database with the same guarded run ID and restore that same
baseline artifact for Run B:

```bash
cd "$REL"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh destroy "$RUN_ID" "$DB"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh prepare "$RUN_ID"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh clone-baseline "$RUN_ID"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh apply-schema "$RUN_ID"

cd "$REL/backend"
export P12_REHEARSAL_DATABASE_URL='postgresql://<approved-role>:<protected-password>@127.0.0.1:5433/'"$DB"
npm run p12:import
export P12_REHEARSAL_LABEL=b
npm run p12:verify
npm run p12:reconcile
npm run p12:compare
unset P12_REHEARSAL_LABEL P12_REHEARSAL_DATABASE_URL
```

The commands create restrictive machine-readable reports under:

```text
reports/a/verification.json
reports/a/reconciliation.json
reports/a/active-state.json
reports/a/auth-references.json
reports/a/summary.json
reports/b/verification.json
reports/b/reconciliation.json
reports/b/active-state.json
reports/b/auth-references.json
reports/b/summary.json
reports/repeatability.json
reports/summary.json
```

Verification fails closed for missing/corrupt artifacts or tables, count or
fingerprint differences, duplicate PK/unique keys, required application FK
orphans, nullability/type mismatches, or invalid sequence state. Auth coupling,
the accepted non-atomic P12 snapshot, and active lifecycle rows are explicit
warnings. Reconciliation never mutates `asset.*`; conflicts and ambiguity require
operator review. Repeatability ignores only run execution metadata and fails for
any application-data or classification difference. Even a complete P12 PASS does
not make P13 ready: P13 still requires an atomic, quiesced, or checkpointed final
cutover strategy.

Optional cleanup requires both the run ID and exact manifest database. It retains
the immutable artifacts for repeatability:

```bash
cd "$REL"
sudo bash deploy/postgresql/p12/p12-rehearsal-db.sh destroy "$RUN_ID" "$DB"
```

The wrapper must be invoked through `sudo` from the approved operator account;
it gives that account access only to the selected run directory while keeping the
baseline dump restricted. It validates the run manifest, exact database, cluster `16/jhcnetops`,
port `5433`, loopback listener, owner, and rehearsal naming contract before any
destructive operation. `dropdb` is not forced; active connections make cleanup fail.
