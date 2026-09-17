import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

import type { P12SnapshotBundle, P12SnapshotManifest } from "./snapshot.js";
import { P12_TABLES, P12_RUN_ID_PATTERN } from "./contract.js";

export const P12_RUN_REPORT_NAMES = Object.freeze([
  "verification", "reconciliation", "active-state", "auth-references", "summary",
] as const);
export type P12RehearsalLabel = "a" | "b";
export type P12RunReportName = (typeof P12_RUN_REPORT_NAMES)[number];

export class P12ArtifactError extends Error {
  readonly code = "P12_ARTIFACT_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12ArtifactError";
  }
}

export function p12RunDirectory(root: string, runId: string): string {
  if (!root.trim() || root.length > 2048 || /[\u0000-\u001f\u007f]/.test(root) || !P12_RUN_ID_PATTERN.test(runId)) {
    throw new P12ArtifactError("P12 artifact location is invalid");
  }
  const resolvedRoot = resolve(root);
  const normalized = resolvedRoot.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalized !== "/var/www/jhc/jhc_noc/shared/p12" && !normalized.endsWith("/.local/p12")) {
    throw new P12ArtifactError("P12 artifacts must use the approved shared or .local/p12 root");
  }
  return join(resolvedRoot, runId);
}

export async function writeSnapshotBundle(root: string, bundle: P12SnapshotBundle): Promise<string> {
  const runDirectory = p12RunDirectory(root, bundle.manifest.run_id);
  const manifestDirectory = join(runDirectory, "manifest");
  const snapshotDirectory = join(runDirectory, "source-snapshot");
  await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
  await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
  for (const definition of P12_TABLES) {
    const content = bundle.artifacts[definition.table];
    if (typeof content !== "string") throw new P12ArtifactError(`P12 artifact for ${definition.table} is unavailable`);
    await writeExclusive(join(snapshotDirectory, `${definition.table}.jsonl`), content);
  }
  await writeExclusive(
    join(manifestDirectory, "source-snapshot.json"),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  );
  return runDirectory;
}

export async function readSnapshotBundle(root: string, runId: string): Promise<P12SnapshotBundle> {
  const runDirectory = p12RunDirectory(root, runId);
  let manifest: P12SnapshotManifest;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(runDirectory, "manifest", "source-snapshot.json"), "utf8"));
    if (!isRecord(parsed)) throw new Error("invalid");
    manifest = parsed as P12SnapshotManifest;
  } catch {
    throw new P12ArtifactError("P12 source snapshot manifest is unavailable or invalid");
  }
  const artifacts: Record<string, string> = {};
  for (const definition of P12_TABLES) {
    try {
      artifacts[definition.table] = await readFile(
        join(runDirectory, "source-snapshot", `${definition.table}.jsonl`),
        "utf8",
      );
    } catch {
      throw new P12ArtifactError(`P12 artifact for ${definition.table} is unavailable`);
    }
  }
  return Object.freeze({ manifest, artifacts: Object.freeze(artifacts) });
}

export async function readLocalBaselineSha256(root: string, runId: string): Promise<string> {
  const file = join(p12RunDirectory(root, runId), "manifest", "local-baseline.sha256");
  try {
    const content = await readFile(file, "utf8");
    const match = content.match(/^([0-9a-f]{64})  asset-baseline\.dump\r?\n?$/i);
    if (!match?.[1]) throw new Error("invalid");
    return match[1].toLowerCase();
  } catch {
    throw new P12ArtifactError("P12 local baseline identity is unavailable or invalid");
  }
}

export async function writeP12RunReport(
  root: string,
  runId: string,
  label: P12RehearsalLabel,
  name: P12RunReportName,
  value: unknown,
): Promise<void> {
  validateLabel(label);
  if (!P12_RUN_REPORT_NAMES.includes(name)) throw new P12ArtifactError("P12 report name is invalid");
  const directory = join(p12RunDirectory(root, runId), "reports", label);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeExclusive(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

export async function readP12RunReport<T>(
  root: string,
  runId: string,
  label: P12RehearsalLabel,
  name: P12RunReportName,
): Promise<T> {
  validateLabel(label);
  if (!P12_RUN_REPORT_NAMES.includes(name)) throw new P12ArtifactError("P12 report name is invalid");
  try {
    return JSON.parse(await readFile(join(p12RunDirectory(root, runId), "reports", label, `${name}.json`), "utf8")) as T;
  } catch {
    throw new P12ArtifactError(`P12 ${name} report for run ${label.toUpperCase()} is unavailable or invalid`);
  }
}

export async function writeP12FinalReport(root: string, runId: string, name: "repeatability" | "summary", value: unknown): Promise<void> {
  const directory = join(p12RunDirectory(root, runId), "reports");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeExclusive(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeExclusive(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch {
    throw new P12ArtifactError("P12 immutable artifact already exists or cannot be written");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLabel(label: string): asserts label is P12RehearsalLabel {
  if (label !== "a" && label !== "b") throw new P12ArtifactError("P12 rehearsal label must be a or b");
}
