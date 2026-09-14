# P12 Schema + Data Migration Dry Run

## Final status

**P12 - Schema + Data Migration Dry Run: DONE.**

The isolated migration rehearsal, verification, and repeatability checks passed.
No application cutover occurred. P13 remains
`BLOCKED_PENDING_FINAL_CUTOVER_STRATEGY` until the final cutover design and
identity-reconciliation disposition are approved.

## Accepted rehearsal identity

| Item | Accepted value |
|---|---|
| Implementation release | `ee1716c` |
| Full source commit | `ee1716c3462c3efafda320c223dc46911b9dcd0b` |
| Run ID | `20260914b` |
| Live `current` during rehearsal | `85309fb` - P11 Local PostgreSQL Foundation |
| Dedicated cluster | PostgreSQL `16/jhcnetops`, port `5433` |
| Live local database | `jhc_netops` |
| Isolated rehearsal database | `jhc_netops_p12_20260914b` |

The `current` symlink was not switched and no PM2 process was stopped or
restarted. Supabase remained the application persistence authority for the
non-local domains; Realtime and Auth were unchanged. The rehearsal wrote only to
the isolated rehearsal database.

## Accepted evidence

One immutable local asset-schema baseline L was captured from the live local
database. Its SHA-256 was:

```text
ba2cfed6091d9b120fb1a887e34b2640b6c3b6c95f1130e657ee29da13f4f4d7
```

The same baseline artifact and hash were verified for Run A and Run B. One
immutable, GET-only Supabase REST snapshot S covered all 21 audited application
tables. The snapshot is explicitly **non-atomic across tables**. That limitation
is accepted only for P12 evidence and is not an acceptable P13 cutover method.

| Evidence | Run A | Run B |
|---|---|---|
| Import | PASS | PASS |
| Verification | PASS | PASS |
| Audited table count | 21 | 21 |
| Active state | PASS | PASS |
| Auth references | PASS | PASS |
| Reconciliation | Recorded | WARN |

All expected machine-readable reports were produced. Run B used the exact same
S and L as Run A. `p12:compare` returned `PASS` with `differences: []`, proving
equivalent outcomes from identical inputs.

The reconciliation warning is expected risk evidence, not a P12 verification
failure. Ambiguous identities remain explicit inputs for P13 review. No automatic
asset merge or overwrite occurred, IP alone was not accepted as durable identity,
and local asset authority was not modified. Detailed production identity findings
remain only in the restricted runtime reports and are not stored in Git.

## Auth and Realtime boundary

P12 preserved Auth-coupled UUID references but did not migrate `auth.users`,
sessions, tokens, or Auth authority. Auth replacement remains P15. P12 did not
replace Supabase Realtime; that remains P14.

## P13 gate

P12 completion does not authorize an immediate cutover. Before any P13 authority
switch, operators must:

1. review, resolve, or explicitly disposition ambiguous identity findings;
2. design the final atomic, quiesced, or checkpointed migration strategy;
3. account for queued/running jobs and active sessions;
4. account for local runner and agent dirty buffers;
5. determine the final delta/freeze procedure;
6. define a rollback checkpoint and split-brain prevention;
7. repeat final pre-cutover verification immediately before the authority switch.

These are P13 planning inputs, not P12 implementation.

## Fail-closed evidence

- Candidate `0446b8a`: inspection found that the rehearsal sequence needed
  `UPDATE` for its bounded `setval()` before real rehearsal writes began.
- Candidate `ba3930d`, Run ID `20260914a`: `prepare` failed before `createdb`
  because the owner lookup used a psql variable through `--command`. Verification
  confirmed the rehearsal database was absent and only the run manifest existed;
  the wrapper was corrected to remain fail-closed.
- Candidate `ee1716c`, Run ID `20260914b`: an initial snapshot invocation supplied
  the short release identifier as `P12_SOURCE_COMMIT`. Validation rejected it
  before source snapshot artifacts were created. The successful rerun used the
  full 40-character source commit.

## Cleanup and retained evidence

After acceptance, `jhc_netops_p12_20260914b` was successfully destroyed. A
second accidental destroy invocation failed closed because that database no
longer existed. The live database and live `current` remained unchanged.

Restricted immutable evidence remains outside Git at:

```text
/var/www/jhc/jhc_noc/shared/p12/20260914b/
```

The retained directories are `manifest/`, `source-snapshot/`, `local-baseline/`,
and `reports/`. They may contain production-derived evidence and must remain
restricted; do not copy their raw contents into the repository.
