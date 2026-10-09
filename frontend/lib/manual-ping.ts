export type ManualPingJob = Readonly<{
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  expires_at: string;
  completed_at?: string | null;
  result: { ok: boolean; latency_ms?: number; category?: string } | null;
  error_code: string | null;
}>;

export type ManualPingOutcome = Readonly<{
  phase: "loading" | "success" | "error";
  key: string;
  code?: string;
  latency?: string;
}>;

export function manualPingFailure(code: string): ManualPingOutcome {
  const messages: Record<string, string> = {
    RUNNER_BUSY: "manualPing.busy",
    ALREADY_ACTIVE: "manualPing.busy",
    RUNNER_OFFLINE: "manualPing.offline",
    RUNNER_NOT_FOUND: "manualPing.offline",
    OPERATION_NOT_AUTHORIZED: "manualPing.unavailable",
    TARGET_NOT_AUTHORIZED: "manualPing.unavailable",
    MANUAL_PING_TARGET_UNAVAILABLE: "manualPing.unavailable",
    MANUAL_PING_EXPIRED: "manualPing.expired",
    MANUAL_PING_TIMEOUT: "manualPing.timeout",
    MANUAL_PING_UNREACHABLE: "manualPing.unreachable",
    MANUAL_PING_RESULT_UNAVAILABLE: "manualPing.resultUnavailable",
    LOCAL_APPLICATION_UNAVAILABLE: "manualPing.resultUnavailable",
    MANUAL_PING_FAILED: "manualPing.failed",
  };
  return { phase: "error", key: Object.hasOwn(messages, code) ? messages[code]! : "manualPing.failed",
    code: Object.hasOwn(messages, code) ? code : "MANUAL_PING_FAILED" };
}

export function manualPingOutcome(job: ManualPingJob): ManualPingOutcome {
  if (job.status === "queued" || job.status === "running") {
    return { phase: "loading", key: job.status === "queued" ? "manualPing.queued" : "mutation.pending.ping" };
  }
  if (job.status === "failed") {
    // Existing DB contract stores lease expiry as TARGET_UNAVAILABLE. Distinguish
    // it using authoritative completion/expiry timestamps, without a migration.
    if (job.error_code === "MANUAL_PING_TARGET_UNAVAILABLE" && job.completed_at &&
        Date.parse(job.completed_at) >= Date.parse(job.expires_at)) return manualPingFailure("MANUAL_PING_EXPIRED");
    return manualPingFailure(job.error_code ?? "MANUAL_PING_FAILED");
  }
  if (!job.result) return manualPingFailure("MANUAL_PING_RESULT_UNAVAILABLE");
  if (job.result.ok && typeof job.result.latency_ms === "number" && Number.isFinite(job.result.latency_ms) &&
      job.result.latency_ms >= 0 && job.result.latency_ms <= 60_000) {
    return { phase: "success", key: "manualPing.result", latency: job.result.latency_ms.toFixed(1) };
  }
  if (!job.result.ok && (job.result.category === "timeout" || job.result.category === "unreachable")) {
    return { phase: "error", key: job.result.category === "timeout" ? "manualPing.timeout" : "manualPing.unreachable",
      code: job.result.category === "timeout" ? "MANUAL_PING_TIMEOUT" : "MANUAL_PING_UNREACHABLE" };
  }
  return manualPingFailure("MANUAL_PING_RESULT_UNAVAILABLE");
}

/** Wait through the server's 30-second lease, not just a 15-second UI window.
 * Unknown/read failures are not evidence of network failure. One read at a time.
 */
export async function waitForManualPing(
  pingId: string,
  read: (id: string) => Promise<{ ok: boolean; data: unknown }>,
  onProgress: (outcome: ManualPingOutcome) => void = () => {},
  clock: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<ManualPingOutcome> {
  const startedAt = clock();
  const maxWaitMs = 35_000;
  while (clock() - startedAt < maxWaitMs) {
    const response = await read(pingId).catch(() => null);
    const job = response?.ok ? parseManualPingJob(response.data, pingId) : null;
    if (job) {
      const outcome = manualPingOutcome(job);
      if (outcome.phase !== "loading") return outcome;
      onProgress(outcome);
    }
    const remaining = maxWaitMs - (clock() - startedAt);
    if (remaining > 0) await sleep(Math.min(1_500, remaining));
  }
  return manualPingFailure("MANUAL_PING_RESULT_UNAVAILABLE");
}

function parseManualPingJob(value: unknown, expectedId: string): ManualPingJob | null {
  if (!record(value) || value.id !== expectedId ||
      (value.status !== "queued" && value.status !== "running" && value.status !== "completed" && value.status !== "failed") ||
      typeof value.expires_at !== "string" || !Number.isFinite(Date.parse(value.expires_at))) return null;
  const result = record(value.result) && typeof value.result.ok === "boolean"
    ? { ok: value.result.ok,
      ...(typeof value.result.latency_ms === "number" ? { latency_ms: value.result.latency_ms } : {}),
      ...(typeof value.result.category === "string" ? { category: value.result.category } : {}) } : null;
  return { id: expectedId, status: value.status, expires_at: value.expires_at,
    completed_at: typeof value.completed_at === "string" ? value.completed_at : null,
    result, error_code: typeof value.error_code === "string" ? value.error_code : null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
