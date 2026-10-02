import type { ManagedDevice, ManagedInterface, ManagedTransition } from "./contract.js";
import type { ObservedHostInput } from "./observed-hosts.js";
export interface ManagedTelemetryRepository {
  listTargets(runnerId: string, signal: AbortSignal): Promise<{ targets: Record<string, unknown>[] }>;
  publish(runnerId: string, device: ManagedDevice, interfaces: ManagedInterface[], transitions: ManagedTransition[], observedHosts: ObservedHostInput[], now: string, signal: AbortSignal): Promise<Record<string, number>>;
}
export class ManagedTelemetryRepositoryError extends Error { constructor(readonly code: "TARGET_NOT_AUTHORIZED") { super(code); this.name = "ManagedTelemetryRepositoryError"; } }
export function managedEvent(item: ManagedTransition, targetId: string) { const context = record(item.raw_context) ? item.raw_context : {}; return { id: item.event_id, created_at: item.occurred_at, severity: item.severity, title: item.title, description: item.description ?? null, source: "managed_telemetry", source_ref: targetId, resolved_at: null, raw_context: { ...context, source: "managed_telemetry", target_id: targetId, event_id: item.event_id, kind: item.kind } }; }
export function nullableText(value: unknown) { return typeof value === "string" && value.length ? value : null; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
