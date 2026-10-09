import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import type { AssetObservation } from "./evidence.js";
import { ASSET_EVIDENCE_ROW_LIMIT } from "./evidence.js";
import { ASSET_SCAN_MAX_HOSTS } from "./scan-contract.js";
import { applyEndpointObservation, endpointContinuityAnchor, normalizeIdentityEvidence, provisionalObservationKey, resolveDeviceIdentity,
  type EndpointAssignment, type IdentityCandidate, type IdentityEvidence, type IdentityResolution, type IdentityState } from "./identity.js";

type Candidate = IdentityCandidate & { stable_source_key: string; identity_state: IdentityState; mac_address: string | null };
type PreparedObservation = Readonly<{
  observation: AssetObservation; evidence: readonly IdentityEvidence[];
  resolution: IdentityResolution; observedAt: string;
}>;
export type PreparedAssetIdentity = PreparedObservation & Readonly<{
  disposition: "ingest"; assetId: string; endpointAnchor: string | null;
  endpointAnchorAliases: readonly string[];
}>;
export type PreparedIdentity = PreparedAssetIdentity | (PreparedObservation & Readonly<{
  disposition: "conflict"; assetId: null;
}>);

export function observationIdentityEvidence(observation: AssetObservation): IdentityEvidence[] {
  if ((observation.identity_evidence?.length ?? 0) > 16) throw new Error("ASSET_IDENTITY_EVIDENCE_LIMIT");
  const inputs = [
    normalizeIdentityEvidence("network_node_binding", observation.network_node_ref),
    normalizeIdentityEvidence("global_mac", observation.mac_address),
    normalizeIdentityEvidence("hostname", observation.hostname),
    ...(observation.identity_evidence ?? []).map((item) => normalizeIdentityEvidence(item.evidence_type, item.normalized_value)),
  ];
  return [...new Map(inputs.filter((item): item is IdentityEvidence => item !== null)
    .map((item) => [`${item.evidence_type}:${item.normalized_value}`, item])).values()];
}

/** All identity selection and endpoint changes run inside the asset ingestion
 * transaction. A shared advisory lock serializes scan and evidence-sync writers. */
export class AssetIdentityRepository {
  constructor(private readonly client: Pick<PoolClient, "query">) {}

  async prepare(observations: readonly AssetObservation[], scanRunId: string | null, signal: AbortSignal): Promise<PreparedIdentity[]> {
    if (observations.length > Math.max(ASSET_EVIDENCE_ROW_LIMIT, ASSET_SCAN_MAX_HOSTS)) throw new Error("ASSET_IDENTITY_INPUT_LIMIT");
    signal.throwIfAborted();
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset.identity-resolution.v1',0))");
    const inputs = observations.map((observation) => {
      const observedAt = observation.evidence_updated_at ?? observation.last_seen_at ?? observation.first_seen_at;
      // No changing clock fallback for IP-only observations: an immutable source
      // observation timestamp or scan token is required for safe retry continuity.
      if (!observedAt || !Number.isFinite(Date.parse(observedAt))) throw new Error("ASSET_IDENTITY_OBSERVATION_INVALID");
      const evidence = observationIdentityEvidence(observation);
      const key = provisionalObservationKey({ sourceKey: observation.stable_source_key, ip: observation.ip_address,
        mac: observation.mac_address, observedAt, scanRunId });
      return { observation, observedAt: new Date(observedAt).toISOString(), evidence, key };
    });
    const valuesFor = (type: IdentityEvidence["evidence_type"]) => [...new Set(inputs.flatMap((input) => input.evidence
      .filter((item) => item.evidence_type === type).map((item) => item.normalized_value)))];
    const rows = await this.client.query<Candidate>({
      text: `SELECT id::text,stable_source_key,network_node_ref::text,identity_state,upper(mac_address::text) AS mac_address
        FROM asset.assets WHERE network_node_ref = ANY($1::uuid[])
          OR upper(mac_address::text) = ANY($2::text[])
          OR stable_source_key = ANY($4::text[])
          OR id IN (SELECT asset_id FROM asset.identity_evidence
            WHERE (evidence_type='snmp_serial' AND normalized_value=ANY($3::text[]))
              OR (evidence_type='global_mac' AND normalized_value=ANY($2::text[])))
        ORDER BY id LIMIT 4001`,
      values: [valuesFor("network_node_binding"), valuesFor("global_mac"), valuesFor("snmp_serial"), inputs.map((input) => input.key)],
    });
    if (rows.rows.length > 4000) throw new Error("ASSET_IDENTITY_CANDIDATE_LIMIT");
    const evidenceRows = await this.client.query<IdentityEvidence & { asset_id: string }>({
      text: `SELECT asset_id::text,evidence_type,normalized_value,strength FROM asset.identity_evidence
        WHERE asset_id=ANY($1::uuid[]) ORDER BY asset_id,evidence_type,normalized_value LIMIT 32001`,
      values: [rows.rows.map((row) => row.id)],
    });
    if (evidenceRows.rows.length > 32000) throw new Error("ASSET_IDENTITY_EVIDENCE_LIMIT");
    const candidates: Candidate[] = rows.rows.map((row) => ({ ...row, evidence: evidenceRows.rows
      .filter((item) => item.asset_id === row.id).map((item) => normalizeIdentityEvidence(item.evidence_type, item.normalized_value))
      .filter((item): item is IdentityEvidence => item !== null) }));
    const prepared: PreparedIdentity[] = [];
    for (const input of inputs) {
      signal.throwIfAborted();
      const resolution = resolveDeviceIdentity(input.evidence, candidates);
      if (resolution.state === "conflict") {
        // Record ambiguity on the existing candidates, never allocate a device
        // or bind a new control-plane node to this ambiguous observation.
        prepared.push({ disposition: "conflict", assetId: null, observation: input.observation,
          evidence: input.evidence, resolution, observedAt: input.observedAt });
        continue;
      }
      const existing = resolution.assetId ? candidates.find((row) => row.id === resolution.assetId)
        : candidates.find((row) => row.stable_source_key === input.key);
      const assetId = existing?.id ?? randomUUID();
      const stableKey = existing?.stable_source_key ?? (resolution.state === "resolved" ? `identity:${assetId}` : input.key);
      const observation = { ...input.observation, stable_source_key: stableKey };
      // Bridge a legacy explicit endpoint to its already-recorded global MAC.
      // A different interface MAC cannot close that endpoint just by sharing a
      // device serial; aliases never cross canonical assets or derive from IP.
      const sameMac = input.evidence.find((item) => item.evidence_type === "global_mac"
        && item.normalized_value === existing?.mac_address);
      const endpointAnchorAliases = resolution.state === "resolved" && sameMac
        ? [`global_mac:${sameMac.normalized_value}`, ...(existing?.network_node_ref ? [`network_node_binding:${existing.network_node_ref}`] : [])] : [];
      if (!existing) candidates.push({ id: assetId, stable_source_key: stableKey, identity_state: resolution.state,
        network_node_ref: observation.network_node_ref, mac_address: observation.mac_address?.toUpperCase() ?? null, evidence: input.evidence });
      else {
        const index = candidates.indexOf(existing);
        candidates[index] = { ...existing, evidence: [...new Map([...existing.evidence, ...input.evidence]
          .map((item) => [`${item.evidence_type}:${item.normalized_value}`, item])).values()] };
      }
      prepared.push({ disposition: "ingest", assetId, observation, evidence: input.evidence, resolution,
        observedAt: input.observedAt, endpointAnchor: endpointContinuityAnchor(input.evidence), endpointAnchorAliases });
    }
    return prepared;
  }

  async persist(prepared: readonly PreparedIdentity[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const stateById = new Map<string, IdentityState>();
    const evidence = new Map<string, IdentityEvidence & { asset_id: string; source: string; first_seen_at: string; last_seen_at: string }>();
    for (const item of prepared) {
      for (const id of item.resolution.conflictIds) stateById.set(id, "conflict");
      if (item.disposition === "conflict") continue;
      if (stateById.get(item.assetId) !== "conflict") stateById.set(item.assetId, item.resolution.state);
      for (const value of item.evidence) {
        const key = `${item.assetId}:${value.evidence_type}:${value.normalized_value}:${item.observation.source}`;
        const previous = evidence.get(key);
        evidence.set(key, { ...value, asset_id: item.assetId, source: item.observation.source,
          first_seen_at: previous && previous.first_seen_at < item.observedAt ? previous.first_seen_at : item.observedAt,
          last_seen_at: previous && previous.last_seen_at > item.observedAt ? previous.last_seen_at : item.observedAt });
      }
    }
    await this.client.query({
      text: `UPDATE asset.assets a SET identity_state=x.state FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,state text)
        WHERE a.id=x.id`, values: [JSON.stringify([...stateById].map(([id, state]) => ({ id, state })))],
    });
    if (evidence.size) await this.client.query({
      text: `INSERT INTO asset.identity_evidence(asset_id,evidence_type,normalized_value,strength,source,first_seen_at,last_seen_at)
        SELECT asset_id,evidence_type,normalized_value,strength,source,first_seen_at,last_seen_at
        FROM jsonb_to_recordset($1::jsonb) AS x(asset_id uuid,evidence_type text,normalized_value text,
          strength text,source text,first_seen_at timestamptz,last_seen_at timestamptz)
        ON CONFLICT (asset_id,evidence_type,normalized_value,source) DO UPDATE SET
          first_seen_at=least(asset.identity_evidence.first_seen_at,EXCLUDED.first_seen_at),
          last_seen_at=greatest(asset.identity_evidence.last_seen_at,EXCLUDED.last_seen_at)`,
      values: [JSON.stringify([...evidence.values()])],
    });
    const endpointInputs = prepared.filter((item): item is PreparedAssetIdentity => item.disposition === "ingest"
      && !!item.observation.ip_address && isIP(item.observation.ip_address) === 4);
    if (!endpointInputs.length) return;
    const existing = await this.client.query<EndpointAssignment>({
      text: `SELECT id::text,asset_id::text,host(ip_address) AS ip_address,state,confidence,source,
        first_seen_at::text,last_seen_at::text,ended_at::text,network_node_ref::text,identity_key
        FROM asset.endpoint_assignments WHERE
          (state='current' AND (asset_id=ANY($1::uuid[]) OR ip_address=ANY($2::inet[])))
          OR (state='unresolved' AND asset_id=ANY($1::uuid[]) AND ip_address=ANY($2::inet[]))
          OR (asset_id=ANY($1::uuid[]) AND first_seen_at=ANY($3::timestamptz[]))
        ORDER BY first_seen_at,id LIMIT 4001 FOR UPDATE`,
      values: [endpointInputs.map((item) => item.assetId), endpointInputs.map((item) => item.observation.ip_address),
        endpointInputs.map((item) => item.observedAt)],
    });
    if (existing.rows.length > 4000) throw new Error("ASSET_ENDPOINT_HISTORY_LIMIT");
    let timeline = existing.rows.map((row) => ({ ...row, first_seen_at: new Date(row.first_seen_at).toISOString(),
      last_seen_at: new Date(row.last_seen_at).toISOString(), ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null }));
    for (const item of endpointInputs) {
      const repeated = timeline.find((row) => row.asset_id === item.assetId && row.ip_address === item.observation.ip_address
        && row.source === item.observation.source && row.first_seen_at === item.observedAt);
      const promotable = item.resolution.state === "resolved" && item.endpointAnchor
        ? timeline.find((row) => row.state === "unresolved" && row.asset_id === item.assetId
          && row.ip_address === item.observation.ip_address && Date.parse(row.last_seen_at) <= Date.parse(item.observedAt)) : undefined;
      const hasCurrentAnchor = item.resolution.state === "resolved" && item.endpointAnchor !== null;
      timeline = applyEndpointObservation(timeline, {
        id: repeated?.id ?? promotable?.id ?? randomUUID(), asset_id: item.assetId, ip_address: item.observation.ip_address!,
        state: hasCurrentAnchor ? "current" : "unresolved",
        confidence: hasCurrentAnchor ? item.observation.network_node_ref ? "authoritative" : "high" : "low",
        source: item.observation.source, first_seen_at: item.observedAt, last_seen_at: item.observedAt,
        ended_at: null, network_node_ref: item.observation.network_node_ref, identity_key: item.endpointAnchor,
      }, item.endpointAnchorAliases);
    }
    signal.throwIfAborted();
    // Close old owners BEFORE inserting current rows, all within the same transaction.
    const closed = timeline.filter((row) => row.state === "historical");
    if (closed.length) await this.client.query({
      text: `UPDATE asset.endpoint_assignments e SET state='historical',ended_at=x.ended_at
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,ended_at timestamptz)
        WHERE e.id=x.id AND e.state='current'`, values: [JSON.stringify(closed)],
    });
    const writes = timeline;
    if (writes.length) await this.client.query({
      text: `INSERT INTO asset.endpoint_assignments(id,asset_id,ip_address,state,confidence,source,
          first_seen_at,last_seen_at,ended_at,network_node_ref,identity_key)
        SELECT id,asset_id,ip_address,state,confidence,source,first_seen_at,last_seen_at,ended_at,network_node_ref,identity_key
        FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,asset_id uuid,ip_address inet,state text,confidence text,
          source text,first_seen_at timestamptz,last_seen_at timestamptz,ended_at timestamptz,network_node_ref uuid,identity_key text)
        ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,confidence=EXCLUDED.confidence,
          last_seen_at=greatest(asset.endpoint_assignments.last_seen_at,EXCLUDED.last_seen_at),
          ended_at=EXCLUDED.ended_at,network_node_ref=EXCLUDED.network_node_ref,identity_key=EXCLUDED.identity_key
        WHERE asset.endpoint_assignments.state='current'
          OR (asset.endpoint_assignments.state='unresolved' AND EXCLUDED.state IN ('unresolved','current'))
          OR (asset.endpoint_assignments.state='historical' AND EXCLUDED.state='historical')`, values: [JSON.stringify(writes)],
    });
  }
}
