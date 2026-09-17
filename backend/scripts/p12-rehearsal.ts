import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import {
  p12RunDirectory,
  readLocalBaselineSha256,
  readP12RunReport,
  readSnapshotBundle,
  writeP12FinalReport,
  writeP12RunReport,
  writeSnapshotBundle,
  P12ArtifactError,
  type P12RehearsalLabel,
} from "../src/data-migration/artifacts.js";
import { importP12Snapshot, parseSnapshotBundle, P12ImportError, type P12ImportQuery } from "../src/data-migration/import.js";
import { loadP12LocalAssets, P12ReconciliationError, reconcileP12Identities, type P12ReconciliationReport } from "../src/data-migration/reconciliation.js";
import { buildP12ActiveStateReport, buildP12AuthReferenceReport, buildP12RunSummary, publicP12Summary, P12ReportingError, type P12ActiveStateReport, type P12AuthReferenceReport, type P12RunSummary } from "../src/data-migration/reporting.js";
import { compareP12Runs, P12RepeatabilityError, type P12RunOutcome } from "../src/data-migration/repeatability.js";
import { captureP12Snapshot, P12SnapshotError, publicSnapshotSummary } from "../src/data-migration/snapshot.js";
import { loadP12Target, P12TargetError } from "../src/data-migration/target.js";
import { loadP12RehearsalData, P12VerificationError, snapshotIdentity, verifyP12Rehearsal, type P12VerificationReport } from "../src/data-migration/verification.js";

const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
const QUERY_TIMEOUT_MS = 60_000;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "snapshot") return snapshot();
  if (command === "import") return importSnapshot();
  if (command === "verify") return verifySnapshot();
  if (command === "reconcile") return reconcileSnapshot();
  if (command === "compare") return compareRuns();
  throw new P12CommandError("Expected an explicit P12 command: snapshot, import, verify, reconcile, or compare");
}

async function snapshot(): Promise<void> {
  const runId = requiredEnvironment("P12_RUN_ID", 48);
  const artifactRoot = requiredEnvironment("P12_ARTIFACT_ROOT", 2048);
  const sourceCommit = requiredEnvironment("P12_SOURCE_COMMIT", 40);
  const supabaseUrl = requiredEnvironment("SUPABASE_URL", 2048);
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY", 4096);
  const schema = await sourceSchemaIdentity();
  // Resolve before source access so malformed output paths fail closed.
  p12RunDirectory(artifactRoot, runId);
  const bundle = await captureP12Snapshot({
    baseUrl: supabaseUrl,
    serviceRoleKey,
    runId,
    sourceCommit,
    sourceSchemaVersion: schema.version,
    sourceSchemaSha256: schema.sha256,
    signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
  });
  const directory = await writeSnapshotBundle(artifactRoot, bundle);
  process.stdout.write(`${JSON.stringify({ ...publicSnapshotSummary(bundle.manifest), artifact_directory: directory })}\n`);
}

async function importSnapshot(): Promise<void> {
  const target = loadP12Target();
  const artifactRoot = requiredEnvironment("P12_ARTIFACT_ROOT", 2048);
  const bundle = await readSnapshotBundle(artifactRoot, target.runId);
  const result = await withRehearsalPool(target.connectionString, "jhc-netops-p12-rehearsal-import", async (query) =>
    importP12Snapshot({ target, bundle, query }));
  process.stdout.write(`${JSON.stringify({ status: "ok", ...result })}\n`);
}

async function verifySnapshot(): Promise<void> {
  const target = loadP12Target();
  const artifactRoot = requiredEnvironment("P12_ARTIFACT_ROOT", 2048);
  const label = rehearsalLabel();
  const bundle = await readSnapshotBundle(artifactRoot, target.runId);
  const baseline = await readLocalBaselineSha256(artifactRoot, target.runId);
  const targetData = await withRehearsalPool(target.connectionString, "jhc-netops-p12-rehearsal-verify", async (query) =>
    loadP12RehearsalData({ target, bundle, query }));
  const verification = verifyP12Rehearsal({ bundle, target: targetData, localBaselineSha256: baseline });
  const active = buildP12ActiveStateReport(bundle);
  const auth = buildP12AuthReferenceReport(bundle);
  await writeP12RunReport(artifactRoot, target.runId, label, "verification", verification);
  await writeP12RunReport(artifactRoot, target.runId, label, "active-state", active);
  await writeP12RunReport(artifactRoot, target.runId, label, "auth-references", auth);
  process.stdout.write(`${JSON.stringify({
    status: verification.overall_status,
    run_id: target.runId,
    rehearsal_label: label,
    table_count: verification.tables.length,
    active_state: active.status,
    auth_references: auth.status,
  })}\n`);
  if (verification.overall_status === "FAIL") process.exitCode = 1;
}

async function reconcileSnapshot(): Promise<void> {
  const target = loadP12Target();
  const artifactRoot = requiredEnvironment("P12_ARTIFACT_ROOT", 2048);
  const label = rehearsalLabel();
  const bundle = await readSnapshotBundle(artifactRoot, target.runId);
  const localAssets = await withRehearsalPool(target.connectionString, "jhc-netops-p12-rehearsal-reconcile", async (query) =>
    loadP12LocalAssets({ target, query }));
  const reconciliation = reconcileP12Identities({ bundle, localAssets });
  const verification = await readP12RunReport<P12VerificationReport>(artifactRoot, target.runId, label, "verification");
  const active = await readP12RunReport<P12ActiveStateReport>(artifactRoot, target.runId, label, "active-state");
  const auth = await readP12RunReport<P12AuthReferenceReport>(artifactRoot, target.runId, label, "auth-references");
  const summary = buildP12RunSummary({ label, bundle, verification, reconciliation, active, auth });
  await writeP12RunReport(artifactRoot, target.runId, label, "reconciliation", reconciliation);
  await writeP12RunReport(artifactRoot, target.runId, label, "summary", summary);
  process.stdout.write(`${JSON.stringify(publicP12Summary(summary))}\n`);
}

async function compareRuns(): Promise<void> {
  const target = loadP12Target();
  const artifactRoot = requiredEnvironment("P12_ARTIFACT_ROOT", 2048);
  const bundle = await readSnapshotBundle(artifactRoot, target.runId);
  parseSnapshotBundle(bundle.manifest, bundle.artifacts);
  const baseline = await readLocalBaselineSha256(artifactRoot, target.runId);
  const runA = await readOutcome(artifactRoot, target.runId, "a");
  const runB = await readOutcome(artifactRoot, target.runId, "b");
  const repeatability = compareP12Runs(runA, runB, () => new Date(), {
    sourceSnapshotSha256: snapshotIdentity(bundle),
    localBaselineSha256: baseline,
  });
  const summary = Object.freeze({
    version: 1,
    run_id: target.runId,
    generated_at: new Date().toISOString(),
    verification_a: runA.verification.overall_status,
    verification_b: runB.verification.overall_status,
    reconciliation_a: runA.reconciliation.overall_status,
    reconciliation_b: runB.reconciliation.overall_status,
    repeatability_status: repeatability.status,
    unresolved_blockers: Object.freeze([...new Set([...runA.summary.unresolved_blockers, ...runB.summary.unresolved_blockers])].sort()),
    preliminary_p13_readiness: "BLOCKED_PENDING_FINAL_CUTOVER_STRATEGY",
  });
  await writeP12FinalReport(artifactRoot, target.runId, "repeatability", repeatability);
  await writeP12FinalReport(artifactRoot, target.runId, "summary", summary);
  process.stdout.write(`${JSON.stringify({ status: repeatability.status, run_id: target.runId, differences: repeatability.differences })}\n`);
  if (repeatability.status === "FAIL") process.exitCode = 1;
}

async function readOutcome(root: string, runId: string, label: P12RehearsalLabel): Promise<P12RunOutcome> {
  const [summary, verification, reconciliation, active, auth] = await Promise.all([
    readP12RunReport<P12RunSummary>(root, runId, label, "summary"),
    readP12RunReport<P12VerificationReport>(root, runId, label, "verification"),
    readP12RunReport<P12ReconciliationReport>(root, runId, label, "reconciliation"),
    readP12RunReport<P12ActiveStateReport>(root, runId, label, "active-state"),
    readP12RunReport<P12AuthReferenceReport>(root, runId, label, "auth-references"),
  ]);
  return Object.freeze({ summary, verification, reconciliation, active, auth });
}

async function withRehearsalPool<T>(
  connectionString: string,
  applicationName: string,
  operation: (query: P12ImportQuery) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS + 1_000,
    application_name: applicationName,
  });
  try {
    const client = await pool.connect();
    try {
      return await operation(async (sql, values) => client.query(sql, values ? [...values] : undefined));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function rehearsalLabel(): P12RehearsalLabel {
  const value = requiredEnvironment("P12_REHEARSAL_LABEL", 1).toLowerCase();
  if (value !== "a" && value !== "b") throw new P12CommandError("P12_REHEARSAL_LABEL must be a or b");
  return value;
}

async function sourceSchemaIdentity(): Promise<Readonly<{ version: string; sha256: string }>> {
  const directory = resolve(REPOSITORY_ROOT, "supabase", "migrations");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  if (!files.length) throw new P12CommandError("Supabase migration sources are unavailable");
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0").update(await readFile(resolve(directory, file))).update("\0");
  }
  return Object.freeze({ version: files.at(-1) ?? "unavailable", sha256: hash.digest("hex") });
}

function requiredEnvironment(name: string, maximum: number): string {
  const value = process.env[name]?.trim();
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new P12CommandError(`${name} is missing or invalid`);
  }
  return value;
}

class P12CommandError extends Error {
  readonly code = "P12_COMMAND_INVALID";
}

try {
  await main();
} catch (error) {
  const known = error instanceof P12CommandError || error instanceof P12TargetError || error instanceof P12ArtifactError ||
    error instanceof P12SnapshotError || error instanceof P12ImportError || error instanceof P12VerificationError ||
    error instanceof P12ReconciliationError || error instanceof P12ReportingError || error instanceof P12RepeatabilityError;
  process.stderr.write(`${JSON.stringify({
    status: "error",
    code: known && "code" in error ? error.code : "P12_OPERATION_FAILED",
    message: known ? error.message : "P12 operation failed",
  })}\n`);
  process.exitCode = 1;
}
