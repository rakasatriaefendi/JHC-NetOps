import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PostgresAdministrativeAuditRepository } from "../src/persistence/administrative-audit.js";
import { ProfilePersistenceError } from "../src/persistence/profiles.js";
import { AuditedReportBranding } from "../src/report-branding/audited-mutations.js";
import { FileReportBrandingStore } from "../src/report-branding/storage.js";
import { buildServer } from "../src/server.js";
import { AuditDatabase, AUDIT_ACTOR } from "./helpers/audit-database.js";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const signal = () => new AbortController().signal;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("migration 017 requires the exact dedicated cluster and latest prerequisite 16, records only 17", () => {
  const sql = source("../migrations/017_administrative_audit.sql");
  for (const guard of ["current_database() <> 'jhc_netops'", "current_setting('port')::integer <> 5433",
    "BETWEEN 160000 AND 169999", "/var/lib/postgresql/16/jhcnetops", "session_user <> 'postgres'",
    "version = 16", "max(version)", "<> 16", "SET ROLE jhc_netops_owner", "RESET ROLE;"]) assert.ok(sql.includes(guard));
  assert.match(sql, /inet_server_addr\(\) IS NOT NULL AND host\(inet_server_addr\(\)\) NOT IN/);
  assert.deepEqual([...sql.matchAll(/INSERT INTO public\.application_schema_migrations\(version\) VALUES \((\d+)\)/g)].map((match) => match[1]), ["17"]);
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP|UPDATE|DELETE FROM)\s+(?:TABLE\s+)?(?:asset\.|public\.(?:profiles|account_lifecycle_audit))/i);
});

test("administrative audit is append-only, non-cascading and restricted to safe fixed summaries", () => {
  const sql = source("../migrations/017_administrative_audit.sql");
  assert.doesNotMatch(sql, /REFERENCES|FOREIGN KEY/);
  assert.match(sql, /REVOKE ALL ON public\.administrative_audit FROM PUBLIC, jhc_netops_app/);
  assert.match(sql, /REVOKE UPDATE, DELETE ON public\.administrative_audit FROM jhc_netops_app/);
  const statements = sql.replace(/--[^\r\n]*/g, "").split(";").map((entry) => entry.trim()).filter((entry) => /^GRANT\b/i.test(entry));
  assert.ok(statements.includes("GRANT SELECT, INSERT ON public.administrative_audit TO jhc_netops_app"));
  for (const statement of statements.filter((entry) => /ON public\.administrative_audit\b/.test(entry))) assert.doesNotMatch(statement.split(" ON ")[0]!, /\bUPDATE\b|\bDELETE\b|\bALL\b/);
  assert.match(sql, /resource_type = 'report_branding'/);
  assert.match(sql, /resource_key = 'institution'/);
  assert.match(sql, /octet_length\(before_state::text\) <= 2048/);
  assert.match(sql, /before_state - ARRAY\['institution_name','division_name','logo_available','logo_mime_type'\] = '\{\}'::jsonb/);
  assert.doesNotMatch(sql, /\bmetadata\b\s+jsonb|password|session_token|base64|filename/);
});

test("audit read authorizes a login-capable approved Admin; deleted lifecycle identities survive UNION read", async () => {
  const db = new AuditDatabase();
  db.readRows = [{ id: "4", source: "account", actor_id: null, actor_name: null, target_name: null,
    resource_type: "profile", resource_key: "22222222-2222-4222-8222-222222222222", action: "account_deleted",
    before_state: { role: "viewer", status: "pending" }, after_state: { role: null, status: null }, occurred_at: new Date("2026-10-07T00:00:00Z") },
  { id: "3", source: "administrative", actor_id: AUDIT_ACTOR, resource_type: "report_branding", resource_key: "institution",
    action: "branding_logo_removed", before_state: {}, after_state: {}, occurred_at: new Date("2026-10-06T00:00:00Z") }];
  const repo = new PostgresAdministrativeAuditRepository(db);
  const rows = await repo.list(AUDIT_ACTOR, 50, signal());
  assert.deepEqual(rows.map((row) => row.source), ["account", "administrative"]);
  assert.equal(rows[0]!.target_name, null);
  assert.equal(rows[0]!.resource_key, db.readRows[0]!.resource_key);
  const read = db.calls.find(({ sql }) => sql.includes("UNION ALL"))!;
  assert.match(read.sql, /public\.account_lifecycle_audit[\s\S]*UNION ALL[\s\S]*public\.administrative_audit/);
  assert.match(read.sql, /ORDER BY e\.occurred_at DESC,e\.source ASC,e\.id::bigint DESC LIMIT 51 OFFSET \$1/);
  assert.deepEqual(read.values, [50]);
  for (const [role, status, credential] of [["operator", "approved", true], ["viewer", "approved", true],
    ["admin", "pending", true], ["admin", "disabled", true], ["admin", "approved", false]] as const) {
    db.role = role; db.status = status; db.credential = credential;
    await assert.rejects(repo.list(AUDIT_ACTOR, 0, signal()), (e: unknown) => e instanceof ProfilePersistenceError && e.code === "ADMIN_ACCESS_REQUIRED");
  }
  await assert.rejects(repo.list(AUDIT_ACTOR, 10001, signal()));
});

test("branding identity meaningful change commits one safe audit; no-op and failure do not commit success", async () => withBranding(async (store, db, writer) => {
  const input = { institutionName: "Hospital", divisionName: "IT" };
  assert.equal((await writer.text(AUDIT_ACTOR, input, signal())).changed, true);
  assert.equal(db.committed.length, 1);
  assert.equal(db.committed[0]![1], "branding_identity_updated");
  assert.equal((await writer.text(AUDIT_ACTOR, input, signal())).changed, false);
  assert.equal(db.committed.length, 1);
  const before = await store.readSnapshot();
  db.failAppend = true;
  await assert.rejects(writer.text(AUDIT_ACTOR, { institutionName: "New hospital", divisionName: "IT" }, signal()));
  assert.deepEqual(await store.readSnapshot(), before);
  assert.equal(db.committed.length, 1);
  const persisted = JSON.parse(String(db.committed[0]![3])) as Record<string, unknown>;
  assert.deepEqual(Object.keys(persisted).sort(), ["division_name", "institution_name", "logo_available", "logo_mime_type"]);
}));

test("logo upload/replacement/remove audit no bytes, file paths or credentials; identical upload/removal are no-ops", async () => withBranding(async (store, db, writer) => {
  const input = { originalFilename: "logo.png", mimeType: "image/png", bytes: PNG };
  await writer.logo(AUDIT_ACTOR, input, signal());
  assert.equal((await writer.logo(AUDIT_ACTOR, input, signal())).changed, false);
  const changedPng = Buffer.from(PNG);
  changedPng[changedPng.length - 1] = 0; // Different bytes, same existing signature contract.
  await writer.logo(AUDIT_ACTOR, { ...input, bytes: changedPng }, signal());
  assert.equal(db.committed.length, 2);
  assert.equal((await writer.remove(AUDIT_ACTOR, signal())).changed, true);
  assert.equal((await writer.remove(AUDIT_ACTOR, signal())).changed, false);
  assert.equal(db.committed.length, 3);
  assert.equal((await store.read()).logo_available, false);
  const serialized = JSON.stringify(db.committed);
  assert.doesNotMatch(serialized, /base64|filename|originalFilename|bytes|password|session|Bearer|report-logo/i);
  assert.ok(!serialized.includes(PNG.toString("base64")));
}));

test("file write failure rolls back audit and non-admin branding mutation is denied", async () => withBranding(async (store, db, writer) => {
  const save = store.saveText.bind(store);
  store.saveText = async () => { throw new Error("private filesystem failure"); };
  await assert.rejects(writer.text(AUDIT_ACTOR, { institutionName: "Hospital", divisionName: "IT" }, signal()));
  assert.equal(db.committed.length, 0);
  store.saveText = save;
  db.role = "operator";
  await assert.rejects(writer.text(AUDIT_ACTOR, { institutionName: "Hospital", divisionName: "IT" }, signal()),
    (error: unknown) => error instanceof ProfilePersistenceError && error.code === "ADMIN_ACCESS_REQUIRED");
  assert.equal(db.committed.length, 0);
  assert.equal((await store.read()).institution_name, "JHC NetOps");
}));

test("secret-shaped branding summaries never become persisted audit or committed branding state", async () => withBranding(async (store, db, writer) => {
  const before = await store.readSnapshot();
  const values = ["Bearer private-fixture-value", "bEaReR private-fixture-value", '"private_key": "private-fixture-value"',
    ...["password", "passwd", "auth_password", "priv_password", "community", "authorization", "session_token",
      "access_token", "refresh_token", "api_key", "apikey", "client_secret", "private_key", "database_url", "service_role", "secret"]
      .flatMap((key) => [`${key}=private-fixture-value`, `${key.toUpperCase()} : private-fixture-value`])];
  for (const value of values) {
    for (const input of [{ institutionName: value, divisionName: "IT" }, { institutionName: "Hospital", divisionName: value }]) {
      await assert.rejects(writer.text(AUDIT_ACTOR, input, signal()));
      assert.deepEqual(await store.readSnapshot(), before);
      assert.equal(db.committed.length, 0);
    }
  }
}));

test("ordinary token/secret/key branding vocabulary remains valid without assignment/header shapes", async () => withBranding(async (store, db, writer) => {
  for (const input of [
    { institutionName: "Token Research Hospital", divisionName: "Secretariat and Key Services" },
    { institutionName: "Secret Garden Hospital", divisionName: "Keyboard and Access Token Research" },
    { institutionName: "Community Hospital", divisionName: "Password Education and API Key Research" },
    { institutionName: "Bearer", divisionName: "Care Center" },
  ]) {
    assert.equal((await writer.text(AUDIT_ACTOR, input, signal())).changed, true);
    assert.equal((await store.read()).institution_name, input.institutionName);
  }
  assert.equal(db.committed.length, 4);
}));

test("audit append reconstructs fixed summaries and discards unrestricted caller metadata", async () => {
  const db = new AuditDatabase();
  const repo = new PostgresAdministrativeAuditRepository(db);
  const before = { institution_name: "Hospital", division_name: "IT", logo_available: false, logo_mime_type: null,
    request_metadata: { secret: "private-fixture-value" }, authorization: "Bearer private-fixture-value" };
  const after = { ...before, division_name: "Secretariat" };
  await repo.withAdmin(AUDIT_ACTOR, signal(), (query) => repo.append(query, AUDIT_ACTOR, "branding_identity_updated", before, after, signal()));
  assert.equal(db.committed.length, 1);
  for (const encoded of db.committed[0]!.slice(2)) {
    const persisted = JSON.parse(String(encoded)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(persisted).sort(), ["division_name", "institution_name", "logo_available", "logo_mime_type"]);
    assert.doesNotMatch(String(encoded), /request_metadata|authorization|private-fixture-value/);
  }
});

test("audit HTTP path requires backend bearer, bounded query and a rechecked Admin", async () => {
  const db = new AuditDatabase();
  const token = "audit-fixture-server-token-only-32";
  const server = buildServer({ logger: false, administrativeAudit: { token, repository: new PostgresAdministrativeAuditRepository(db) } });
  const url = `/api/application/administrative-audit?actor_id=${AUDIT_ACTOR}`;
  try {
    assert.equal((await server.inject({ method: "GET", url })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await server.inject({ method: "GET", url, headers })).statusCode, 200);
    assert.equal((await server.inject({ method: "GET", url: `${url}&secret=x`, headers })).statusCode, 400);
    assert.equal((await server.inject({ method: "GET", url: `${url}&offset=10001`, headers })).statusCode, 400);
    db.role = "viewer";
    const rejected = await server.inject({ method: "GET", url, headers });
    assert.equal(rejected.statusCode, 403);
    assert.doesNotMatch(rejected.body, /SELECT|password|postgres|Bearer/);
  } finally { await server.close(); }
});

async function withBranding(run: (store: FileReportBrandingStore, db: AuditDatabase, writer: AuditedReportBranding) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "jhc-audited-branding-"));
  try {
    const store = new FileReportBrandingStore(dir);
    const db = new AuditDatabase();
    await run(store, db, new AuditedReportBranding(store, new PostgresAdministrativeAuditRepository(db)));
  } finally { await rm(dir, { recursive: true, force: true }); }
}
