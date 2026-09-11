export const REPORT_BRANDING_NAME_MAX_LENGTH = 160;
export const REPORT_BRANDING_LOGO_MAX_BYTES = 10 * 1024 * 1024;
export const REPORT_BRANDING_LOGO_REQUEST_MAX_BYTES = 14 * 1024 * 1024 + 1024;

export type ReportLogoMimeType = "image/png" | "image/jpeg";
export type ReportLogoExtension = "png" | "jpeg";

export type ReportBranding = Readonly<{
  institution_name: string;
  division_name: string;
  logo_available: boolean;
  logo_mime_type: ReportLogoMimeType | null;
  updated_at: string | null;
}>;

export type ReportLogo = Readonly<{
  bytes: Buffer;
  mimeType: ReportLogoMimeType;
  extension: ReportLogoExtension;
  width: number;
  height: number;
}>;

export type ReportBrandingSnapshot = Readonly<{
  branding: ReportBranding;
  logo: ReportLogo | null;
}>;

export type ReportBrandingTextInput = Readonly<{
  institutionName: string;
  divisionName: string;
}>;

export type ReportLogoInput = Readonly<{
  originalFilename: string;
  mimeType: string;
  bytes: Buffer;
}>;

export const DEFAULT_REPORT_BRANDING: ReportBranding = Object.freeze({
  institution_name: "JHC NetOps",
  division_name: "",
  logo_available: false,
  logo_mime_type: null,
  updated_at: null,
});

export function validateReportBrandingText(value: unknown): ReportBrandingTextInput | null {
  if (!record(value) || !onlyKeys(value, ["institution_name", "division_name"])) return null;
  const institutionName = validName(value.institution_name, true);
  const divisionName = validName(value.division_name, false);
  return institutionName !== null && divisionName !== null ? { institutionName, divisionName } : null;
}

export function validateReportLogo(input: ReportLogoInput): ReportLogo | null {
  if (!input.bytes.length || input.bytes.length > REPORT_BRANDING_LOGO_MAX_BYTES ||
      input.originalFilename.length > 255 || /[\\/\u0000]/.test(input.originalFilename) ||
      input.originalFilename === "." || input.originalFilename === "..") return null;
  const extension = filenameExtension(input.originalFilename);
  if (!extension) return null;
  const signature = imageSignature(input.bytes);
  if (!signature || signature.extension !== extension || signature.mimeType !== input.mimeType) return null;
  return { bytes: input.bytes, ...signature };
}

export function decodeReportLogoRequest(value: unknown): ReportLogoInput | null {
  if (!record(value) || !onlyKeys(value, ["filename", "mime_type", "base64"]) ||
      typeof value.filename !== "string" || typeof value.mime_type !== "string" || typeof value.base64 !== "string" ||
      value.base64.length > Math.ceil(REPORT_BRANDING_LOGO_MAX_BYTES / 3) * 4 + 4 ||
      value.base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) return null;
  const bytes = Buffer.from(value.base64, "base64");
  return { originalFilename: value.filename, mimeType: value.mime_type, bytes };
}

function validName(value: unknown, required: boolean): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > REPORT_BRANDING_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function filenameExtension(filename: string): ReportLogoExtension | null {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!match) return null;
  if (match[1] === "png") return "png";
  if (match[1] === "jpg" || match[1] === "jpeg") return "jpeg";
  return null;
}

function imageSignature(bytes: Buffer): Omit<ReportLogo, "bytes"> | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return validDimensions(width, height) ? { mimeType: "image/png", extension: "png", width, height } : null;
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    const dimensions = jpegDimensions(bytes);
    return dimensions ? { mimeType: "image/jpeg", extension: "jpeg", ...dimensions } : null;
  }
  return null;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return validDimensions(width, height) ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width <= 20_000 && height <= 20_000;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
