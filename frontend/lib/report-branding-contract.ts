export const REPORT_BRANDING_NAME_MAX_LENGTH = 160;
export const REPORT_BRANDING_LOGO_MAX_BYTES = 10 * 1024 * 1024;

export type ReportBranding = Readonly<{
  institution_name: string;
  division_name: string;
  logo_available: boolean;
  logo_mime_type: "image/png" | "image/jpeg" | null;
  updated_at: string | null;
}>;

export const DEFAULT_REPORT_BRANDING: ReportBranding = {
  institution_name: "JHC NetOps",
  division_name: "",
  logo_available: false,
  logo_mime_type: null,
  updated_at: null,
};

export function validReportBranding(value: unknown): value is ReportBranding {
  if (!record(value)) return false;
  return typeof value.institution_name === "string" && value.institution_name.length > 0 && value.institution_name.length <= REPORT_BRANDING_NAME_MAX_LENGTH &&
    typeof value.division_name === "string" && value.division_name.length <= REPORT_BRANDING_NAME_MAX_LENGTH &&
    typeof value.logo_available === "boolean" &&
    (value.logo_mime_type === null || value.logo_mime_type === "image/png" || value.logo_mime_type === "image/jpeg") &&
    (value.updated_at === null || typeof value.updated_at === "string" && Number.isFinite(Date.parse(value.updated_at)));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
