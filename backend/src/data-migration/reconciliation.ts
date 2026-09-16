import { canonicalJson, parseLosslessJson } from "./canonical.js";
import { isIP } from "node:net";
import { parseSnapshotBundle, P12_TARGET_IDENTITY_SQL, validateP12TargetIdentity, type P12ImportQuery } from "./import.js";
import type { P12SnapshotBundle } from "./snapshot.js";
import type { P12Target } from "./target.js";
import { parseP12Target } from "./target.js";
import type { P12CheckStatus } from "./verification.js";

export const P12_RECONCILIATION_ASSET_LIMIT = 1_000_000;
export const P12_RECONCILIATION_PAGE_SIZE = 500;
export const P12_RECONCILIATION_CATEGORIES = ["EXACT_MATCH", "SOURCE_ONLY", "LOCAL_ONLY", "CONFLICT", "AMBIGUOUS"] as const;
export type P12ReconciliationCategory = (typeof P12_RECONCILIATION_CATEGORIES)[number];

export type P12LocalAsset = Readonly<{
  id: string;
  stable_source_key: string;
  name: string;
  device_type: string;
  ip_address: string | null;
  mac_address: string | null;
  source: string;
  network_node_ref: string | null;
  health_target_ref: string | null;
  managed_telemetry_target_ref: string | null;
  observed_host_target_ref: string | null;
}>;

export type P12ReconciliationFinding = Readonly<{
  category: P12ReconciliationCategory;
  source_table: string | null;
  source_stable_identifier: string | null;
  local_asset_identifier: string | null;
  identity_rule: string;
  differing_fields: readonly string[];
  recommended_p13_handling: string;
}>;

export type P12ReconciliationReport = Readonly<{
  version: 1;
  run_id: string;
  generated_at: string;
  overall_status: P12CheckStatus;
  category_counts: Readonly<Record<P12ReconciliationCategory, number>>;
  findings: readonly P12ReconciliationFinding[];
  unclassified_count: 0;
}>;

export class P12ReconciliationError extends Error {
  readonly code = "P12_RECONCILIATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "P12ReconciliationError";
  }
}

type SourceIdentity = Readonly<{
  sourceTable: "network_nodes" | "managed_observed_hosts_latest";
  stableIdentifier: string;
  nodeId: string | null;
  observedTargetId: string | null;
  healthTargetIds: readonly string[];
  managedTargetIds: readonly string[];
  ip: string;
  mac: string | null;
  name: string | null;
  deviceType: string | null;
}>;

type PlannedMatch = {
  source: SourceIdentity;
  candidates: P12LocalAsset[];
  rule: string;
};

export async function loadP12LocalAssets(options: Readonly<{
  target: P12Target;
  query: P12ImportQuery;
}>): Promise<readonly P12LocalAsset[]> {
  const target = parseP12Target(options.target.runId, options.target.connectionString);
  if (target.database !== options.target.database) throw new P12ReconciliationError("P12 reconciliation target is invalid");
  try {
    validateP12TargetIdentity(await options.query(P12_TARGET_IDENTITY_SQL), target);
    const countResult = await options.query("SELECT count(*)::text AS row_count FROM asset.assets");
    const count = assetCount(countResult.rows?.[0]?.row_count);
    const assets: P12LocalAsset[] = [];
    for (let offset = 0; offset < count; offset += P12_RECONCILIATION_PAGE_SIZE) {
      const result = await options.query(P12_ASSET_ROWS_SQL, [P12_RECONCILIATION_PAGE_SIZE, offset]);
      const rows = result.rows ?? [];
      if (!rows.length || rows.length > P12_RECONCILIATION_PAGE_SIZE) throw new P12ReconciliationError("P12 local asset page is incomplete");
      assets.push(...rows.map(({ row_json }) => parseLocalAsset(row_json)));
      if (assets.length > count) throw new P12ReconciliationError("P12 local asset baseline changed during reconciliation");
    }
    if (assets.length !== count) throw new P12ReconciliationError("P12 local asset count is inconsistent");
    return Object.freeze(assets);
  } catch (error) {
    if (error instanceof P12ReconciliationError) throw error;
    throw new P12ReconciliationError("P12 local asset baseline could not be loaded safely");
  }
}

export function reconcileP12Identities(options: Readonly<{
  bundle: P12SnapshotBundle;
  localAssets: readonly P12LocalAsset[];
  now?: () => Date;
}>): P12ReconciliationReport {
  const rows = parseSnapshotBundle(options.bundle.manifest, options.bundle.artifacts);
  const identities = sourceIdentities(rows);
  validateLocalAssets(options.localAssets);
  const localByStableKey = groupBy(options.localAssets, ({ stable_source_key }) => stable_source_key);
  const localByNode = groupBy(options.localAssets.filter(({ network_node_ref }) => network_node_ref !== null), ({ network_node_ref }) => network_node_ref ?? "");
  const localByMac = groupBy(options.localAssets.filter(({ mac_address }) => usableMac(mac_address)), ({ mac_address }) => normalizeMac(mac_address));
  const plans: PlannedMatch[] = identities.map((source) => {
    const stable = localByStableKey.get(source.stableIdentifier) ?? [];
    const node = source.nodeId ? localByNode.get(source.nodeId) ?? [] : [];
    const observed = source.observedTargetId
      ? options.localAssets.filter((asset) => asset.observed_host_target_ref === source.observedTargetId && asset.ip_address === source.ip)
      : [];
    const contextual = options.localAssets.filter((asset) =>
      (asset.health_target_ref !== null && source.healthTargetIds.includes(asset.health_target_ref)) ||
      (asset.managed_telemetry_target_ref !== null && source.managedTargetIds.includes(asset.managed_telemetry_target_ref)));
    const strong = uniqueAssets([...stable, ...node, ...observed, ...contextual]);
    if (strong.length) return {
      source,
      candidates: strong,
      rule: node.length ? "network_node_ref" : stable.length ? "stable_source_key" : observed.length ? "observed_target_and_ip" : "target_reference",
    };
    const mac = source.mac ? localByMac.get(normalizeMac(source.mac)) ?? [] : [];
    return { source, candidates: uniqueAssets(mac), rule: mac.length ? "unique_mac_evidence" : "no_durable_identity" };
  });
  const candidateUse = groupBy(plans.filter(({ candidates }) => candidates.length === 1), ({ candidates }) => candidates[0]?.id ?? "");
  const matchedLocalIds = new Set<string>();
  const findings: P12ReconciliationFinding[] = [];

  for (const plan of plans) {
    if (plan.candidates.length === 0) {
      findings.push(finding("SOURCE_ONLY", plan.source, null, plan.rule, []));
      continue;
    }
    for (const candidate of plan.candidates) matchedLocalIds.add(candidate.id);
    if (plan.candidates.length > 1 || (candidateUse.get(plan.candidates[0]?.id ?? "")?.length ?? 0) > 1) {
      findings.push(finding("AMBIGUOUS", plan.source, null, plan.rule, []));
      continue;
    }
    const local = plan.candidates[0];
    if (!local) throw new P12ReconciliationError("P12 reconciliation produced an unclassified identity");
    const differences = identityDifferences(plan.source, local, options.localAssets);
    findings.push(finding(differences.length ? "CONFLICT" : "EXACT_MATCH", plan.source, local.id, plan.rule, differences));
  }
  for (const asset of options.localAssets) {
    if (!matchedLocalIds.has(asset.id)) findings.push(finding("LOCAL_ONLY", null, asset.id, "no_source_identity", []));
  }
  findings.sort((left, right) => canonicalJson([left.category, left.source_stable_identifier, left.local_asset_identifier])
    < canonicalJson([right.category, right.source_stable_identifier, right.local_asset_identifier]) ? -1 :
    canonicalJson([left.category, left.source_stable_identifier, left.local_asset_identifier])
      > canonicalJson([right.category, right.source_stable_identifier, right.local_asset_identifier]) ? 1 : 0);
  const counts = Object.fromEntries(P12_RECONCILIATION_CATEGORIES.map((category) => [category, findings.filter((item) => item.category === category).length])) as Record<P12ReconciliationCategory, number>;
  const differences = counts.SOURCE_ONLY + counts.LOCAL_ONLY + counts.CONFLICT + counts.AMBIGUOUS;
  return Object.freeze({
    version: 1,
    run_id: options.bundle.manifest.run_id,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    overall_status: differences ? "WARN" : "PASS",
    category_counts: Object.freeze(counts),
    findings: Object.freeze(findings),
    unclassified_count: 0,
  });
}

export const P12_ASSET_ROWS_SQL = `
SELECT row_to_json(p12_asset)::text AS row_json
FROM (
  SELECT id::text, stable_source_key, name, device_type, host(ip_address) AS ip_address,
    mac_address::text, source, network_node_ref::text, health_target_ref::text,
    managed_telemetry_target_ref::text, observed_host_target_ref::text
  FROM asset.assets
  ORDER BY stable_source_key, id
  LIMIT $1 OFFSET $2
) p12_asset
`.trim();

function sourceIdentities(rows: ReadonlyMap<string, readonly Readonly<Record<string, unknown>>[]>): SourceIdentity[] {
  const healthByNode = groupStrings(rows.get("network_targets") ?? [], "node_id", "id");
  const managedByNode = groupStrings(rows.get("managed_telemetry_targets") ?? [], "node_id", "id");
  const observedByNode = groupBy((rows.get("managed_observed_hosts_latest") ?? []).filter(({ node_id }) => node_id !== null), ({ node_id }) => String(node_id));
  const identities: SourceIdentity[] = [];
  const nodeIds = new Set<string>();
  for (const node of rows.get("network_nodes") ?? []) {
    const id = requiredIdentifier(node.id, "network_nodes.id");
    const ip = requiredIp(node.ip_address, "network_nodes.ip_address");
    if (nodeIds.has(id)) throw new P12ReconciliationError("P12 source identity is duplicated");
    nodeIds.add(id);
    const observed = observedByNode.get(id) ?? [];
    const macs = [...new Set(observed.map(({ mac_address }) => normalizeMac(mac_address)).filter(Boolean))];
    identities.push(Object.freeze({
      sourceTable: "network_nodes",
      stableIdentifier: `node:${id}`,
      nodeId: id,
      observedTargetId: null,
      healthTargetIds: Object.freeze(healthByNode.get(id) ?? []),
      managedTargetIds: Object.freeze(managedByNode.get(id) ?? []),
      ip,
      mac: macs.length === 1 ? macs[0] ?? null : null,
      name: optionalText(node.name),
      deviceType: optionalText(node.device_type),
    }));
  }
  for (const observed of rows.get("managed_observed_hosts_latest") ?? []) {
    if (observed.node_id !== null && observed.node_id !== undefined) {
      const nodeId = requiredIdentifier(observed.node_id, "managed_observed_hosts_latest.node_id");
      if (!nodeIds.has(nodeId)) throw new P12ReconciliationError("P12 observed host references an unavailable source node");
      continue;
    }
    const targetId = requiredIdentifier(observed.target_id, "managed_observed_hosts_latest.target_id");
    const ip = requiredIp(observed.ip_address, "managed_observed_hosts_latest.ip_address");
    identities.push(Object.freeze({
      sourceTable: "managed_observed_hosts_latest",
      stableIdentifier: `observed:${targetId}:${ip}`,
      nodeId: null,
      observedTargetId: targetId,
      healthTargetIds: Object.freeze([]),
      managedTargetIds: Object.freeze([targetId]),
      ip,
      mac: usableMac(observed.mac_address) ? normalizeMac(observed.mac_address) : null,
      name: optionalText(observed.netbios_name),
      deviceType: null,
    }));
  }
  const keys = identities.map(({ stableIdentifier }) => stableIdentifier);
  if (new Set(keys).size !== keys.length) throw new P12ReconciliationError("P12 source stable identity is duplicated");
  return identities.sort((left, right) => left.stableIdentifier < right.stableIdentifier ? -1 : left.stableIdentifier > right.stableIdentifier ? 1 : 0);
}

function identityDifferences(source: SourceIdentity, local: P12LocalAsset, allAssets: readonly P12LocalAsset[]): string[] {
  const differences: string[] = [];
  if (local.ip_address && local.ip_address !== source.ip) differences.push("ip_address");
  if (source.mac && local.mac_address && normalizeMac(local.mac_address) !== source.mac) differences.push("mac_address");
  if (local.health_target_ref && !source.healthTargetIds.includes(local.health_target_ref)) differences.push("health_target_ref");
  if (local.managed_telemetry_target_ref && !source.managedTargetIds.includes(local.managed_telemetry_target_ref)) differences.push("managed_telemetry_target_ref");
  if (source.sourceTable === "network_nodes" && local.source !== "manual") {
    if (source.name && local.name.trim().toLowerCase() !== source.name.trim().toLowerCase()) differences.push("name");
    if (source.deviceType && local.device_type !== source.deviceType) differences.push("device_type");
  }
  if (allAssets.some((asset) => asset.id !== local.id && asset.ip_address === source.ip)) differences.push("ip_address_ownership");
  if (source.mac && allAssets.some((asset) => asset.id !== local.id && usableMac(asset.mac_address) && normalizeMac(asset.mac_address) === source.mac)) differences.push("mac_address_ownership");
  return [...new Set(differences)].sort();
}

function finding(
  category: P12ReconciliationCategory,
  source: SourceIdentity | null,
  localId: string | null,
  rule: string,
  differences: readonly string[],
): P12ReconciliationFinding {
  const handling: Record<P12ReconciliationCategory, string> = {
    EXACT_MATCH: "preserve_existing_identity",
    SOURCE_ONLY: "review_before_candidate_insert",
    LOCAL_ONLY: "preserve_local_authority",
    CONFLICT: "operator_review_required",
    AMBIGUOUS: "no_automatic_winner",
  };
  return Object.freeze({
    category,
    source_table: source?.sourceTable ?? null,
    source_stable_identifier: source?.stableIdentifier ?? null,
    local_asset_identifier: localId,
    identity_rule: rule,
    differing_fields: Object.freeze([...differences]),
    recommended_p13_handling: handling[category],
  });
}

function validateLocalAssets(assets: readonly P12LocalAsset[]): void {
  const ids = new Set<string>();
  const stable = new Set<string>();
  for (const asset of assets) {
    if (!identifier(asset.id) || !asset.stable_source_key || !asset.name || !asset.device_type || !asset.source ||
        (asset.ip_address !== null && !ipAddress(asset.ip_address)) ||
        (asset.mac_address !== null && !usableMac(asset.mac_address)) ||
        [asset.network_node_ref, asset.health_target_ref, asset.managed_telemetry_target_ref, asset.observed_host_target_ref]
          .some((value) => value !== null && !identifier(value))) {
      throw new P12ReconciliationError("P12 local asset is malformed");
    }
    if (ids.has(asset.id) || stable.has(asset.stable_source_key)) throw new P12ReconciliationError("P12 local asset identity is duplicated");
    ids.add(asset.id);
    stable.add(asset.stable_source_key);
  }
}

function parseLocalAsset(value: unknown): P12LocalAsset {
  if (typeof value !== "string") throw new P12ReconciliationError("P12 local asset row is malformed");
  let parsed: unknown;
  try { parsed = parseLosslessJson(value); } catch { throw new P12ReconciliationError("P12 local asset row is invalid JSON"); }
  if (!record(parsed)) throw new P12ReconciliationError("P12 local asset row is malformed");
  const nullable = (key: string): string | null => parsed[key] === null ? null : requiredString(parsed[key]);
  return Object.freeze({
    id: requiredString(parsed.id),
    stable_source_key: requiredString(parsed.stable_source_key),
    name: requiredString(parsed.name),
    device_type: requiredString(parsed.device_type),
    ip_address: nullable("ip_address"),
    mac_address: nullable("mac_address"),
    source: requiredString(parsed.source),
    network_node_ref: nullable("network_node_ref"),
    health_target_ref: nullable("health_target_ref"),
    managed_telemetry_target_ref: nullable("managed_telemetry_target_ref"),
    observed_host_target_ref: nullable("observed_host_target_ref"),
  });
}

function uniqueAssets(assets: readonly P12LocalAsset[]): P12LocalAsset[] {
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]);
  return result;
}

function groupStrings(rows: readonly Readonly<Record<string, unknown>>[], keyColumn: string, valueColumn: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const key = requiredIdentifier(row[keyColumn], `${keyColumn} reference`);
    const value = requiredIdentifier(row[valueColumn], `${valueColumn} reference`);
    result.set(key, [...(result.get(key) ?? []), value].sort());
  }
  return result;
}

function assetCount(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new P12ReconciliationError("P12 local asset count is malformed");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0 || count > P12_RECONCILIATION_ASSET_LIMIT) throw new P12ReconciliationError("P12 local asset count exceeds the bound");
  return count;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (!identifier(value)) throw new P12ReconciliationError(`P12 ${field} is malformed`);
  return value;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requiredIp(value: unknown, field: string): string {
  if (typeof value !== "string" || !ipAddress(value)) throw new P12ReconciliationError(`P12 ${field} is malformed`);
  return value;
}

function ipAddress(value: string): boolean {
  return isIP(value) !== 0;
}

function usableMac(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value) && value !== "00:00:00:00:00:00";
}

function normalizeMac(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new P12ReconciliationError("P12 local asset field is malformed");
  return value;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
