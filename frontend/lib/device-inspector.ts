export type InspectionConfidence = "high" | "medium" | "low" | "unknown";

export type DeviceEvidence = { source: string; label: string; value: string };
export type ObservedService = { name: string; protocol: "tcp" | "udp"; port: number };
export type ObservedServiceState = ObservedService & { state: "open" | "closed" | "filtered" | "unknown" | "timeout" };
export type InspectorCollectorStatus = "completed" | "timeout" | "failed" | "skipped_budget";

export type DeviceFingerprint = {
  schema_version: number;
  ip: string;
  reachable: boolean;
  route_role: "default_gateway" | "on_link" | "routed";
  same_subnet: boolean;
  network_context?: {
    is_this_device: boolean;
    automated_role: "this_device" | null;
    interface_index: number | null;
    interface_alias: string | null;
    interface_description: string | null;
    interface_type: "physical" | "virtual" | "unknown";
  };
  network_identity: {
    mac: string | null;
    mac_kind: "global" | "locally_administered" | "unavailable";
    mac_vendor: string | null;
    tls_identity: string | null;
  };
  detected_identity: {
    manufacturer: string | null;
    model: string | null;
    model_number: string | null;
    os_family: string | null;
    likely_label: string | null;
  };
  likely_device_type: string;
  capabilities: string[];
  confidence: InspectionConfidence;
  observed_services: ObservedService[];
  observed_software: string[];
  evidence: DeviceEvidence[];
  probe_summary: {
    tcp_ports_checked: number[];
    tcp_open_count: number;
    tcp_states?: ObservedServiceState[];
    upnp_checked: boolean;
    netbios_checked?: boolean;
    collector_statuses?: Record<string, InspectorCollectorStatus>;
    partial?: boolean;
    deadline_reached?: boolean;
    optional_skips: string[];
  };
  limitations: string[];
};

export type DeviceInspectionSession = {
  runner_id: string;
  inspection_id: string;
  requested_by: string;
  target_ip: string;
  authorization_source: "discovery" | "inventory";
  status: "queued" | "running" | "completed" | "failed" | "expired";
  stage: "validating_target" | "network_role" | "identity" | "services" | "normalizing" | "complete";
  result: DeviceFingerprint | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  updated_at: string;
};

export type InspectorRunner = {
  id: string;
  display_name: string;
  last_seen_at: string;
  health_status: "online" | "degraded";
  capabilities: {
    operations?: string[];
    device_inspector?: {
      available: boolean;
      probe_engine: string;
      collectors?: Record<string, boolean>;
      optional?: Record<string, boolean>;
      available_but_unused?: Record<string, boolean>;
      optional_not_required?: Record<string, boolean>;
    };
  };
};

export function inspectionErrorDetails(code: string | null | undefined) {
  const fallback = {
    title: "Inspeksi perangkat tidak dapat diselesaikan.",
    action: "Coba lagi. Jika tetap gagal, periksa status dan log Local Runner.",
  };
  return ({
    TARGET_NOT_AUTHORIZED: { title: "Target belum diizinkan untuk diperiksa.", action: "Tambahkan perangkat ke inventory atau jalankan discovery resmi terlebih dahulu." },
    INVALID_INSPECTION_TARGET: { title: "Target tidak diizinkan oleh runner.", action: "Pastikan alamat IP private tersebut masih tercatat di inventory." },
    RUNNER_OFFLINE: { title: "Local Runner sedang offline.", action: "Nyalakan kembali Local Runner, tunggu status online, lalu coba lagi." },
    RUNNER_BUSY: { title: "Local Runner sedang menjalankan operasi lain.", action: "Tunggu operasi aktif selesai, lalu jalankan inspeksi kembali." },
    INSPECTION_NOT_AUTHORIZED: { title: "Runner ini belum mengizinkan Device Inspector.", action: "Jalankan capability preflight dan restart Local Runner." },
    INSPECTION_NETWORK_CONTEXT_UNAVAILABLE: { title: "Konteks jaringan Windows untuk target ini tidak dapat ditentukan.", action: "Periksa route Windows ke target dan coba lagi dari adapter yang aktif." },
    INSPECTION_CONTEXT_INVALID: { title: "Konteks jaringan target tidak valid.", action: "Periksa route dan alamat target, lalu restart Local Runner sebelum mencoba lagi." },
    INSPECTION_WSL_UNAVAILABLE: { title: "WSL untuk Device Inspector tidak dapat dijalankan.", action: "Periksa distro WSL yang dikonfigurasi dan jalankan preflight runner." },
    WSL_READINESS_TIMEOUT: { title: "WSL belum siap dalam batas waktu.", action: "Periksa status distro WSL dan log Local Runner, lalu coba lagi setelah WSL siap." },
    WSL_RUNTIME_FAILED: { title: "WSL gagal menjalankan pemeriksaan kesiapan.", action: "Periksa distro WSL yang dikonfigurasi dan jalankan preflight runner." },
    INSPECTION_AGENT_UNAVAILABLE: { title: "Device Inspector tidak tersedia di environment agent.", action: "Jalankan network-monitor capabilities dari project virtualenv lalu restart runner." },
    INSPECTION_TIMEOUT: { title: "Inspeksi melewati batas waktu aman.", action: "Pastikan target dapat dijangkau lalu coba sekali lagi." },
    AGENT_PROTOCOL_ERROR: { title: "Hasil agent tidak sesuai format aman.", action: "Periksa versi agent dan runner, lalu restart keduanya sebelum mencoba lagi." },
    INSPECTION_FAILED: { title: "Inspeksi perangkat gagal.", action: "Periksa log Local Runner untuk kode aman terakhir, lalu coba lagi." },
  } as Record<string, typeof fallback>)[code ?? ""] ?? fallback;
}

export function confidenceLabel(value: InspectionConfidence) {
  return value === "high" ? "HIGH" : value === "medium" ? "MEDIUM" : value === "low" ? "LOW" : "UNKNOWN";
}

export function detectedLabel(fingerprint: DeviceFingerprint | null) {
  return fingerprint?.detected_identity.likely_label
    || fingerprint?.detected_identity.model
    || (fingerprint?.likely_device_type && fingerprint.likely_device_type !== "unknown" ? fingerprint.likely_device_type : null)
    || (fingerprint ? "Insufficient evidence" : null)
    || "No detected identity saved";
}

const INFRASTRUCTURE_TYPES = new Set([
  "gateway", "router", "layer3_switch", "managed_switch", "firewall",
  "access_point", "printer", "camera", "iot", "phone",
]);

export function canLaunchActiveInspection(role: "admin" | "viewer") {
  return role === "admin";
}

export function operatorIdentityConflict(deviceType: string | null | undefined, fingerprint: DeviceFingerprint | null) {
  return Boolean(fingerprint?.network_context?.is_this_device && deviceType && INFRASTRUCTURE_TYPES.has(deviceType));
}

export function shouldOfferHealthPromotion(monitored: boolean | null, nodeId: string | null | undefined, runnerId: string | null | undefined) {
  return monitored === false && Boolean(nodeId && runnerId);
}
