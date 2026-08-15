import type { DiagnosticJob } from "@/lib/diagnostic-jobs";

export const STAGE_ORDER = [
  "queued",
  "preparing_runner",
  "starting_wsl",
  "checking_target",
  "upload",
  "download",
  "mtr",
  "saving",
  "complete",
] as const;

export type StepState = "completed" | "active" | "pending" | "failed";

export type DiagnosticStep = {
  id: "runner" | "target" | "upload" | "download" | "path" | "save";
  label: string;
  state: StepState;
};

const STEP_STAGE: Record<DiagnosticStep["id"], string> = {
  runner: "starting_wsl",
  target: "checking_target",
  upload: "upload",
  download: "download",
  path: "mtr",
  save: "saving",
};

const STEP_LABEL: Record<DiagnosticStep["id"], string> = {
  runner: "Runner ready",
  target: "Target reachable",
  upload: "Upload",
  download: "Download",
  path: "Path",
  save: "Save",
};

export function diagnosticStageLabel(job: DiagnosticJob) {
  if (job.status === "completed") return "Diagnostik selesai";
  if (job.status === "failed") return "Diagnostik gagal";
  return ({
    queued: "Menunggu Local Runner...",
    preparing_runner: "Menyiapkan diagnostic runner...",
    starting_wsl: "Menjalankan WSL...",
    checking_target: "Memeriksa koneksi ke target...",
    upload: "Mengukur upload...",
    download: "Mengukur download...",
    mtr: "Menganalisis jalur jaringan...",
    saving: "Menyimpan hasil...",
    complete: "Diagnostik selesai",
  } as Record<string, string>)[job.stage] ?? "Memproses diagnostik...";
}

export function diagnosticSteps(job: DiagnosticJob): DiagnosticStep[] {
  const failedStep = job.status === "failed" ? failureStep(job.error_code) : null;
  const currentIndex = Math.max(0, STAGE_ORDER.indexOf(job.stage as typeof STAGE_ORDER[number]));
  return (Object.keys(STEP_STAGE) as DiagnosticStep["id"][]).map((id) => {
    const stepIndex = STAGE_ORDER.indexOf(STEP_STAGE[id] as typeof STAGE_ORDER[number]);
    let state: StepState = "pending";
    if (job.status === "completed" || job.stage === "complete" || currentIndex > stepIndex) {
      state = "completed";
    } else if (currentIndex === stepIndex || (id === "runner" && currentIndex <= stepIndex)) {
      state = "active";
    }
    if (failedStep === id) state = "failed";
    return { id, label: STEP_LABEL[id], state };
  });
}

export function safeFailureMessage(code: string | null) {
  return ({
    WSL_DISTRO_NOT_FOUND: "Distribusi WSL tidak ditemukan.",
    WSL_START_FAILED: "WSL gagal dijalankan.",
    AGENT_VENV_MISSING: "Virtualenv agent tidak ditemukan.",
    AGENT_PYTHON_UNSUPPORTED: "Versi Python agent tidak didukung.",
    INVALID_TARGET: "Target tidak diizinkan oleh runner lokal.",
    TARGET_UNREACHABLE: "Target tidak dapat dihubungi.",
    IPERF3_MISSING: "iperf3 tidak tersedia di WSL.",
    IPERF3_SERVER_UNAVAILABLE: "Server iperf3 tidak tersedia pada target.",
    UPLOAD_FAILED: "Pengujian upload gagal.",
    DOWNLOAD_FAILED: "Pengujian download gagal.",
    MTR_FAILED: "Analisis jalur jaringan gagal.",
    MTR_MISSING: "mtr tidak tersedia di WSL.",
    BACKEND_UPLOAD_FAILED: "Hasil diagnostik gagal disimpan.",
    JOB_TIMEOUT: "Diagnostik melewati batas waktu.",
    AGENT_PROTOCOL_ERROR: "Respons agent tidak valid.",
    NETWORK_CONTEXT_UNAVAILABLE: "Konteks jaringan Windows tidak dapat dibaca.",
    NETWORK_CONTEXT_INVALID: "Konteks jaringan Windows tidak valid.",
    NETWORK_INTERFACE_DOWN: "Interface Windows untuk target tidak aktif.",
    NO_ROUTE_TO_TARGET: "Windows tidak memiliki route ke target resmi.",
  } as Record<string, string>)[code ?? ""] ?? "Diagnostik gagal. Silakan coba lagi.";
}

function failureStep(code: string | null): DiagnosticStep["id"] {
  if (code === "UPLOAD_FAILED") return "upload";
  if (code === "DOWNLOAD_FAILED") return "download";
  if (code === "MTR_FAILED" || code === "MTR_MISSING") return "path";
  if (code === "BACKEND_UPLOAD_FAILED") return "save";
  if (code === "INVALID_TARGET" || code === "TARGET_UNREACHABLE" || code === "IPERF3_SERVER_UNAVAILABLE" || code === "NO_ROUTE_TO_TARGET") return "target";
  return "runner";
}
