export type DeviceInspectionStage = "validating_target" | "network_role" | "identity" | "services" | "normalizing" | "complete";
export type DeviceFingerprint = Readonly<Record<string, unknown> & { ip: string }>;

export type DeviceInspectionRequest =
  | Readonly<{ action: "claim_session"; runner_id: string }>
  | Readonly<{ action: "update_stage"; runner_id: string; inspection_id: string; stage: DeviceInspectionStage }>
  | Readonly<{ action: "complete_session"; runner_id: string; inspection_id: string; result: DeviceFingerprint }>
  | Readonly<{ action: "fail_session"; runner_id: string; inspection_id: string; error_code: string }>;

type ValidationResult =
  | Readonly<{ ok: true; value: DeviceInspectionRequest }>
  | Readonly<{ ok: false; message: string; tooLarge?: boolean }>;

const RUNNER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const STAGES = new Set<DeviceInspectionStage>(["validating_target", "network_role", "identity", "services", "normalizing", "complete"]);
const FORBIDDEN_RESULT_KEYS = /^(raw|stdout|stderr|html|xml|body|payload|cookie|token|authorization|credential|password|secret)$/i;

export function validateDeviceInspectionRequest(value: unknown): ValidationResult {
  if (!record(value) || typeof value.action !== "string" || typeof value.runner_id !== "string"
      || !RUNNER_ID.test(value.runner_id)) return invalid("Device inspection request is invalid");
  if (value.action === "claim_session") {
    return exactKeys(value, ["action", "runner_id"])
      ? { ok: true, value: { action: "claim_session", runner_id: value.runner_id } }
      : invalid("Device inspection request is invalid");
  }
  if (typeof value.inspection_id !== "string" || !UUID.test(value.inspection_id)) {
    return invalid("Device inspection session is invalid");
  }
  if (value.action === "update_stage") {
    return typeof value.stage === "string" && STAGES.has(value.stage as DeviceInspectionStage)
      && exactKeys(value, ["action", "runner_id", "inspection_id", "stage"])
      ? { ok: true, value: { action: "update_stage", runner_id: value.runner_id,
        inspection_id: value.inspection_id, stage: value.stage as DeviceInspectionStage } }
      : invalid("Device inspection stage is invalid");
  }
  if (value.action === "complete_session") {
    if (!exactKeys(value, ["action", "runner_id", "inspection_id", "result"]) || !validFingerprint(value.result)) {
      return invalid("Normalized fingerprint is invalid");
    }
    if (Buffer.byteLength(JSON.stringify(value.result), "utf8") > 64 * 1024) {
      return { ok: false, message: "Inspection result exceeds safety bounds", tooLarge: true };
    }
    if (containsForbiddenResult(value.result)) return invalid("Inspection result contains prohibited raw content");
    return { ok: true, value: { action: "complete_session", runner_id: value.runner_id,
      inspection_id: value.inspection_id, result: value.result } };
  }
  if (value.action === "fail_session" && exactKeys(value, ["action", "runner_id", "inspection_id", "error_code"])) {
    const errorCode = typeof value.error_code === "string" && ERROR_CODE.test(value.error_code)
      ? value.error_code
      : "INSPECTION_FAILED";
    return { ok: true, value: { action: "fail_session", runner_id: value.runner_id,
      inspection_id: value.inspection_id, error_code: errorCode } };
  }
  return invalid("Device inspection request is invalid");
}

function validFingerprint(value: unknown): value is DeviceFingerprint {
  return record(value) && privateIpv4(value.ip)
    && ["high", "medium", "low", "unknown"].includes(String(value.confidence))
    && typeof value.likely_device_type === "string" && value.likely_device_type.length <= 128
    && Array.isArray(value.capabilities) && value.capabilities.length <= 16
    && Array.isArray(value.evidence) && value.evidence.length <= 32;
}
function containsForbiddenResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenResult);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN_RESULT_KEYS.test(key) || containsForbiddenResult(nested));
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && Object.keys(value).every((key) => expected.includes(key));
}
function invalid(message: string): ValidationResult { return { ok: false, message }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function privateIpv4(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  const d = Number(parts[3]);
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c) || !Number.isInteger(d)) return false;
  if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 255 || d < 0 || d > 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
