import "server-only";
import { localApplicationRequest } from "./application-persistence";

export type AuditEntry = {
  id: string; source: "account" | "administrative"; action: string;
  actor_id: string | null; actor_name: string | null; target_name: string | null;
  actor_email: string | null; target_email: string | null;
  resource_type: "profile" | "report_branding"; resource_key: string;
  before_state: Record<string, unknown>; after_state: Record<string, unknown>; occurred_at: string;
};
const actions = new Set(["access_changed", "account_disabled", "account_reenabled", "account_deleted",
  "branding_identity_updated", "branding_logo_updated", "branding_logo_removed"]);
export async function loadAdministrativeAudit(actorId: string, page: number) {
  const result = await localApplicationRequest("GET", `/api/application/administrative-audit?actor_id=${encodeURIComponent(actorId)}&offset=${page * 50}`);
  if (!result.ok || !Array.isArray(result.data) || result.data.length > 51 || !result.data.every(validEntry)) {
    return { entries: [] as AuditEntry[], more: false, error: true };
  }
  return { entries: result.data.slice(0, 50), more: result.data.length > 50, error: false };
}
function validEntry(value: unknown): value is AuditEntry {
  if (!record(value) || typeof value.id !== "string" || !["account", "administrative"].includes(String(value.source)) ||
    typeof value.action !== "string" || !actions.has(value.action) ||
    !["profile", "report_branding"].includes(String(value.resource_type)) || typeof value.resource_key !== "string" || value.resource_key.length > 64 ||
    typeof value.occurred_at !== "string" || !Number.isFinite(Date.parse(value.occurred_at)) ||
    !record(value.before_state) || !record(value.after_state)) return false;
  return [value.actor_id, value.actor_name, value.target_name].every((v) => v === null || typeof v === "string" && v.length <= 200) &&
    [value.actor_email, value.target_email].every((v) => v === null || typeof v === "string" && v.length <= 320);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
