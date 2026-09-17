import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  armLocalAuthority,
  createP13CutoverRecord,
  parseP13CutoverRecord,
  recordFinalCapture,
  recordFinalImport,
  recordFinalVerification,
  recordFreezeReadiness,
  recordPostCutoverVerification,
  recordPostflight,
  recordPreCutoverVerification,
  rollbackCheck,
  safeP13Failure,
  type P13CutoverRecord,
  type P13ImportEvidence,
} from "../src/cutover/cutover.js";
import { evaluateP13Readiness, type P13ReadinessEvidence } from "../src/cutover/readiness.js";
import { loadP13Target, P13_ACTIONS, type P13Action, publicP13Target } from "../src/cutover/target.js";
import {
  assertP13VerificationPassed,
  verifyP13PostCutover,
  verifyP13PreCutover,
  type P13PostCutoverEvidence,
  type P13PreCutoverEvidence,
} from "../src/cutover/verification.js";

const action = process.argv[2] as P13Action | undefined;

try {
  if (!action || !P13_ACTIONS.includes(action)) throw new Error("Usage: p13-cutover <explicit-stage>");
  const target = loadP13Target(action, process.env);
  const recordPath = requiredPath("P13_CUTOVER_RECORD_PATH");
  let result: unknown;

  if (action === "preflight") {
    await assertMissing(recordPath);
    const record = createP13CutoverRecord(target);
    await createRecord(recordPath, record);
    result = { status: "PASS", action, target: publicP13Target(target), checkpoint: record.checkpoint };
  } else {
    const record = await readRecord(recordPath);
    assertActionIdentity(record, target.source_checkpoint_identity);
    if (action === "freeze-check") {
      const readiness = evaluateP13Readiness(
        await readJson<P13ReadinessEvidence>(requiredPath("P13_EVIDENCE_PATH")),
        "pre_migration_freeze",
      );
      const updated = recordFreezeReadiness(record, readiness);
      await replaceRecord(recordPath, updated);
      result = { status: readiness.status, action, blockers: readiness.blockers, evidence_sha256: readiness.evidence_sha256 };
    } else if (action === "capture-final") {
      const snapshotHash = await fileSha256(requiredPath("P13_EVIDENCE_PATH"));
      const updated = recordFinalCapture(record, snapshotHash);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, snapshot_sha256: snapshotHash, checkpoint: updated.checkpoint };
    } else if (action === "import-final") {
      const evidence = await readJson<P13ImportEvidence>(requiredPath("P13_EVIDENCE_PATH"));
      const updated = recordFinalImport(record, evidence);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, checkpoint: updated.checkpoint };
    } else if (action === "verify-final") {
      const evidence = await readJson<P13ImportEvidence>(requiredPath("P13_EVIDENCE_PATH"));
      const updated = recordFinalVerification(record, evidence);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, checkpoint: updated.checkpoint };
    } else if (action === "pre-cutover-verify") {
      const evidence = await readJson<Omit<P13PreCutoverEvidence, "cutover_record">>(requiredPath("P13_EVIDENCE_PATH"));
      const verification = verifyP13PreCutover({ ...evidence, cutover_record: record });
      assertP13VerificationPassed(verification);
      const updated = recordPreCutoverVerification(record, verification);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, checks: verification.checks, evidence_sha256: verification.evidence_sha256 };
    } else if (action === "arm-local-authority") {
      const readiness = evaluateP13Readiness(
        await readJson<P13ReadinessEvidence>(requiredPath("P13_EVIDENCE_PATH")),
        "post_import_authority",
      );
      const updated = armLocalAuthority(record, readiness);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, checkpoint: updated.checkpoint, persistence_authority: updated.persistence_authority };
    } else if (action === "postflight") {
      const evidence = await readJson<{ status: "PASS" | "FAIL"; local_authoritative_write_count: number }>(requiredPath("P13_EVIDENCE_PATH"));
      const updated = recordPostflight(record, evidence);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, local_authoritative_write_count: updated.local_authoritative_write_count };
    } else if (action === "post-cutover-verify") {
      const evidence = await readJson<Omit<P13PostCutoverEvidence, "cutover_record">>(requiredPath("P13_EVIDENCE_PATH"));
      const verification = verifyP13PostCutover({ ...evidence, cutover_record: record });
      assertP13VerificationPassed(verification);
      const updated = recordPostCutoverVerification(record, verification);
      await replaceRecord(recordPath, updated);
      result = { status: "PASS", action, checks: verification.checks, evidence_sha256: verification.evidence_sha256 };
    } else if (action === "rollback-check") {
      const evidence = await readJson<{ local_writers_frozen: boolean; all_local_writes_projected: boolean; shadow_parity_verified: boolean }>(requiredPath("P13_EVIDENCE_PATH"));
      result = { status: "PASS", action, rollback: rollbackCheck(record, evidence) };
    } else {
      throw new Error("P13 action is not implemented");
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const failure = safeP13Failure(error);
  process.stderr.write(`${JSON.stringify({
    status: "BLOCKED",
    ...failure,
  })}\n`);
  process.exitCode = 1;
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} is missing or invalid`);
  return resolve(value);
}

async function readRecord(path: string): Promise<P13CutoverRecord> {
  return parseP13CutoverRecord(await readJson(path));
}

async function readJson<T = unknown>(path: string): Promise<T> {
  const text = await readFile(path, "utf8");
  if (text.length > 2 * 1024 * 1024) throw new Error("P13 evidence exceeds the bounded size");
  return JSON.parse(text) as T;
}

async function fileSha256(path: string): Promise<string> {
  const content = await readFile(path);
  if (content.byteLength > 512 * 1024 * 1024) throw new Error("P13 snapshot artifact exceeds the bounded size");
  return createHash("sha256").update(content).digest("hex");
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error("P13 cutover record already exists; refuse to overwrite it");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function createRecord(path: string, record: P13CutoverRecord): Promise<void> {
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function replaceRecord(path: string, record: P13CutoverRecord): Promise<void> {
  const temporary = resolve(dirname(path), `.${Date.now()}-p13-cutover.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

function assertActionIdentity(record: P13CutoverRecord, sourceCheckpointIdentity: string): void {
  if (record.source_checkpoint_identity !== sourceCheckpointIdentity) {
    throw new Error("P13 action source checkpoint does not match the immutable cutover record");
  }
}
