import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_REPORT_BRANDING,
  REPORT_BRANDING_LOGO_MAX_BYTES,
  validateReportLogo,
} from "../src/report-branding/contract.js";
import { FileReportBrandingStore } from "../src/report-branding/storage.js";
import { buildServer } from "../src/server.js";
import { AuditedReportBranding } from "../src/report-branding/audited-mutations.js";
import { PostgresAdministrativeAuditRepository } from "../src/persistence/administrative-audit.js";
import { AuditDatabase, AUDIT_ACTOR } from "./helpers/audit-database.js";

const TOKEN = "b".repeat(32);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0, 0xff, 0xd9]);

test("filesystem branding store falls back safely and persists text atomically", async () => withStore(async (directory, store) => {
  assert.deepEqual(await store.read(), DEFAULT_REPORT_BRANDING);
  const saved = await store.saveText({ institutionName: "JHC Hospital", divisionName: "IT Division" });
  assert.equal(saved.institution_name, "JHC Hospital");
  assert.equal(saved.division_name, "IT Division");
  assert.equal((await new FileReportBrandingStore(directory).read()).institution_name, "JHC Hospital");
  assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  await writeFile(join(directory, "branding.json"), "{malformed", "utf8");
  assert.deepEqual(await store.read(), DEFAULT_REPORT_BRANDING);
}));

test("logo validation binds extension, MIME and signature and remains bounded", () => {
  assert.equal(validateReportLogo({ originalFilename: "logo.png", mimeType: "image/png", bytes: PNG })?.extension, "png");
  assert.equal(validateReportLogo({ originalFilename: "logo.jpg", mimeType: "image/jpeg", bytes: JPEG })?.extension, "jpeg");
  for (const input of [
    { originalFilename: "../logo.png", mimeType: "image/png", bytes: PNG },
    { originalFilename: "logo.jpg", mimeType: "image/png", bytes: PNG },
    { originalFilename: "logo.png", mimeType: "image/jpeg", bytes: PNG },
    { originalFilename: "logo.png", mimeType: "image/png", bytes: Buffer.alloc(REPORT_BRANDING_LOGO_MAX_BYTES + 1) },
  ]) assert.equal(validateReportLogo(input), null);
});

test("logo replacement uses canonical files and removal preserves report identity", async () => withStore(async (directory, store) => {
  await store.saveText({ institutionName: "Hospital", divisionName: "NOC" });
  assert.equal((await store.saveLogo({ originalFilename: "brand.png", mimeType: "image/png", bytes: PNG })).logo_mime_type, "image/png");
  assert.deepEqual((await store.readSnapshot()).logo?.bytes, PNG);
  await store.saveLogo({ originalFilename: "brand.jpeg", mimeType: "image/jpeg", bytes: JPEG });
  assert.deepEqual((await readdir(directory)).sort(), ["branding.json", "report-logo.jpg"]);
  const removed = await store.removeLogo();
  assert.equal(removed.logo_available, false);
  assert.equal(removed.institution_name, "Hospital");
  assert.deepEqual(await readdir(directory), ["branding.json"]);
}));

test("branding routes require authentication and never expose paths or arbitrary input", async () => withStore(async (directory, store) => {
  const database = new AuditDatabase();
  const server = buildServer({ logger: false, reportBranding: { token: TOKEN, store,
    mutations: new AuditedReportBranding(store, new PostgresAdministrativeAuditRepository(database)) } });
  assert.equal((await server.inject({ method: "GET", url: "/api/report-branding" })).statusCode, 401);
  assert.equal((await server.inject({ method: "PUT", url: "/api/report-branding", headers: auth(), payload: { institution_name: "Hospital", division_name: "IT", secret: "no" } })).statusCode, 400);
  for (const payload of [
    { input: { institution_name: "Hospital", division_name: "IT" } },
    { actor_id: "invalid", input: { institution_name: "Hospital", division_name: "IT" } },
    { actor_id: AUDIT_ACTOR, input: { institution_name: "Hospital", division_name: "IT" }, role: "admin" },
  ]) assert.equal((await server.inject({ method: "PUT", url: "/api/report-branding", headers: auth(), payload })).statusCode, 400);
  const saved = await server.inject({ method: "PUT", url: "/api/report-branding", headers: auth(), payload: { actor_id: AUDIT_ACTOR, input: { institution_name: "Hospital", division_name: "IT" } } });
  assert.equal(saved.statusCode, 200);
  const uploaded = await server.inject({ method: "PUT", url: "/api/report-branding/logo", headers: auth(), payload: { actor_id: AUDIT_ACTOR, input: { filename: "logo.png", mime_type: "image/png", base64: PNG.toString("base64") } } });
  assert.equal(uploaded.statusCode, 200);
  const logo = await server.inject({ method: "GET", url: "/api/report-branding/logo", headers: auth() });
  assert.equal(logo.headers["content-type"], "image/png");
  assert.deepEqual(logo.rawPayload, PNG);
  assert.doesNotMatch(saved.body + uploaded.body, new RegExp(directory.replaceAll("\\", "\\\\"), "i"));
  assert.doesNotMatch(saved.body + uploaded.body, /password|service_role|authorization/i);
  database.role = "operator";
  assert.equal((await server.inject({ method: "DELETE", url: "/api/report-branding/logo", headers: auth(), payload: { actor_id: AUDIT_ACTOR } })).statusCode, 403);
  assert.equal((await store.read()).logo_available, true);
  await server.close();
}));

async function withStore(run: (directory: string, store: FileReportBrandingStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "jhc-report-branding-"));
  try { await run(directory, new FileReportBrandingStore(directory, () => new Date("2026-09-10T00:00:00Z"))); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function auth() { return { authorization: `Bearer ${TOKEN}` }; }
