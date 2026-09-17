import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import {
  bootstrapP13S1,
  P13_APPLICATION_TABLES,
  P13BootstrapError,
  type P13BootstrapQuery,
} from "../src/cutover/bootstrap.js";
import { parseP13CutoverRecord } from "../src/cutover/cutover.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TABLE_ARTIFACT_BYTES = 512 * 1024 * 1024;

try {
  const mode = requiredEnvironment("P13_IMPORT_MODE", 16);
  if (mode !== "bootstrap") throw new P13BootstrapError("P13 import mode must be explicitly set to bootstrap");
  const sourceCheckpointIdentity = requiredHash("P13_SOURCE_CHECKPOINT_IDENTITY");
  const expectedManifestSha256 = requiredHash("P13_EXPECTED_S1_MANIFEST_SHA256");
  const manifestPath = requiredPath("P13_S1_MANIFEST_PATH");
  if (basename(manifestPath) !== "manifest.json") {
    throw new P13BootstrapError("P13 S1 manifest must be the reviewed evidence/s1/manifest.json artifact");
  }
  const manifestText = await boundedRead(manifestPath, MAX_MANIFEST_BYTES);
  const s1Root = dirname(manifestPath);
  const tablesRoot = resolve(s1Root, "tables");
  const artifacts: Record<string, string> = {};
  for (const table of P13_APPLICATION_TABLES) {
    artifacts[table] = await boundedReadWithin(
      resolve(tablesRoot, `${table}.json`),
      s1Root,
      MAX_TABLE_ARTIFACT_BYTES,
    );
  }
  const record = parseP13CutoverRecord(JSON.parse(await boundedStandardInput(MAX_MANIFEST_BYTES)));
  const [migration007, migration008] = await Promise.all([
    boundedRead(resolve(REPOSITORY_ROOT, "backend", "migrations", "007_application_persistence.sql"), MAX_MANIFEST_BYTES),
    boundedRead(resolve(REPOSITORY_ROOT, "backend", "migrations", "008_application_persistence_outbox.sql"), MAX_MANIFEST_BYTES),
  ]);

  const pool = new Pool({
    host: "/var/run/postgresql",
    port: 5433,
    database: "jhc_netops",
    user: "postgres",
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15 * 60_000,
    query_timeout: 15 * 60_000 + 1_000,
    application_name: "jhc-netops-p13-s1-bootstrap",
  });
  try {
    const client = await pool.connect();
    try {
      const query: P13BootstrapQuery = async (sql, values) =>
        client.query(sql, values ? [...values] : undefined);
      const evidence = await bootstrapP13S1({
        mode,
        record,
        source_checkpoint_identity: sourceCheckpointIdentity,
        expected_s1_manifest_sha256: expectedManifestSha256,
        manifest_text: manifestText,
        artifacts: Object.freeze(artifacts),
        migration_007: migration007,
        migration_008: migration008,
        query,
      });
      const output = `${JSON.stringify(evidence, null, 2)}\n`;
      if (Buffer.byteLength(output) > MAX_MANIFEST_BYTES) {
        throw new P13BootstrapError("P13 import evidence exceeds its bound");
      }
      process.stdout.write(output);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  const known = error instanceof P13BootstrapError;
  process.stderr.write(`${JSON.stringify({
    status: "BLOCKED",
    code: known ? error.code : "P13_BOOTSTRAP_FAILED",
    message: known ? error.message : "P13 S1 bootstrap failed safely",
  })}\n`);
  process.exitCode = 1;
}

async function boundedRead(path: string, maximum: number): Promise<string> {
  if ((await stat(path)).size > maximum) throw new P13BootstrapError("P13 bootstrap artifact exceeds its bound");
  return readFile(path, "utf8");
}

async function boundedReadWithin(path: string, root: string, maximum: number): Promise<string> {
  const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (!fromRoot || fromRoot.startsWith("..") || resolve(resolvedRoot, fromRoot) !== resolvedPath) {
    throw new P13BootstrapError("P13 S1 table artifact resolves outside its immutable root");
  }
  return boundedRead(resolvedPath, maximum);
}

async function boundedStandardInput(maximum: number): Promise<string> {
  process.stdin.setEncoding("utf8");
  let content = "";
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > maximum) throw new P13BootstrapError("P13 cutover record exceeds its bound");
    content += chunk;
  }
  return content;
}

function requiredEnvironment(name: string, maximum: number): string {
  const value = process.env[name]?.trim();
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new P13BootstrapError(`${name} is missing or invalid`);
  }
  return value;
}

function requiredHash(name: string): string {
  const value = requiredEnvironment(name, 64);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new P13BootstrapError(`${name} is invalid`);
  return value;
}

function requiredPath(name: string): string {
  return resolve(requiredEnvironment(name, 2048));
}
