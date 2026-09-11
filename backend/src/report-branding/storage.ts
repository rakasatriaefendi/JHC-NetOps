import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_REPORT_BRANDING,
  type ReportBranding,
  type ReportBrandingSnapshot,
  type ReportBrandingTextInput,
  type ReportLogo,
  type ReportLogoInput,
  validateReportLogo,
} from "./contract.js";

const CONFIG_FILENAME = "branding.json";
const PNG_FILENAME = "report-logo.png";
const JPEG_FILENAME = "report-logo.jpg";

type PersistedBranding = Readonly<{
  version: 1;
  institution_name: string;
  division_name: string;
  logo: Readonly<{ filename: typeof PNG_FILENAME | typeof JPEG_FILENAME; mime_type: "image/png" | "image/jpeg" }> | null;
  updated_at: string;
}>;

export interface ReportBrandingStore {
  read(): Promise<ReportBranding>;
  readSnapshot(): Promise<ReportBrandingSnapshot>;
  saveText(input: ReportBrandingTextInput): Promise<ReportBranding>;
  saveLogo(input: ReportLogoInput): Promise<ReportBranding>;
  removeLogo(): Promise<ReportBranding>;
}

export class FileReportBrandingStore implements ReportBrandingStore {
  #mutations: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string, private readonly now = () => new Date()) {}

  async read(): Promise<ReportBranding> {
    return (await this.readSnapshot()).branding;
  }

  async readSnapshot(): Promise<ReportBrandingSnapshot> {
    const state = await this.#readPersisted();
    if (!state) return { branding: DEFAULT_REPORT_BRANDING, logo: null };
    const logo = state.logo ? await this.#readLogo(state.logo) : null;
    return {
      branding: {
        institution_name: state.institution_name,
        division_name: state.division_name,
        logo_available: logo !== null,
        logo_mime_type: logo?.mimeType ?? null,
        updated_at: state.updated_at,
      },
      logo,
    };
  }

  saveText(input: ReportBrandingTextInput): Promise<ReportBranding> {
    return this.#serialize(async () => {
      const current = await this.#readPersisted();
      const next: PersistedBranding = {
        version: 1,
        institution_name: input.institutionName,
        division_name: input.divisionName,
        logo: current?.logo ?? null,
        updated_at: this.now().toISOString(),
      };
      await this.#writeConfig(next);
      return this.read();
    });
  }

  saveLogo(input: ReportLogoInput): Promise<ReportBranding> {
    return this.#serialize(async () => {
      const logo = validateReportLogo(input);
      if (!logo) throw new ReportBrandingStorageError("INVALID_REPORT_LOGO");
      const current = await this.#readPersisted();
      const filename = logo.extension === "png" ? PNG_FILENAME : JPEG_FILENAME;
      await this.#writeAtomic(filename, logo.bytes);
      const next: PersistedBranding = {
        version: 1,
        institution_name: current?.institution_name ?? DEFAULT_REPORT_BRANDING.institution_name,
        division_name: current?.division_name ?? DEFAULT_REPORT_BRANDING.division_name,
        logo: { filename, mime_type: logo.mimeType },
        updated_at: this.now().toISOString(),
      };
      await this.#writeConfig(next);
      await rm(join(this.directory, filename === PNG_FILENAME ? JPEG_FILENAME : PNG_FILENAME), { force: true }).catch(() => undefined);
      return this.read();
    });
  }

  removeLogo(): Promise<ReportBranding> {
    return this.#serialize(async () => {
      const current = await this.#readPersisted();
      const next: PersistedBranding = {
        version: 1,
        institution_name: current?.institution_name ?? DEFAULT_REPORT_BRANDING.institution_name,
        division_name: current?.division_name ?? DEFAULT_REPORT_BRANDING.division_name,
        logo: null,
        updated_at: this.now().toISOString(),
      };
      await this.#writeConfig(next);
      await Promise.all([PNG_FILENAME, JPEG_FILENAME].map((filename) => rm(join(this.directory, filename), { force: true }).catch(() => undefined)));
      return this.read();
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation, operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readPersisted(): Promise<PersistedBranding | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.directory, CONFIG_FILENAME), "utf8"));
      return validPersisted(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async #readLogo(metadata: NonNullable<PersistedBranding["logo"]>): Promise<ReportLogo | null> {
    try {
      const bytes = await readFile(join(this.directory, metadata.filename));
      return validateReportLogo({ originalFilename: metadata.filename, mimeType: metadata.mime_type, bytes });
    } catch {
      return null;
    }
  }

  async #writeConfig(state: PersistedBranding): Promise<void> {
    await this.#writeAtomic(CONFIG_FILENAME, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8"));
  }

  async #writeAtomic(filename: string, bytes: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, join(this.directory, filename));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export class ReportBrandingStorageError extends Error {
  constructor(readonly code: "INVALID_REPORT_LOGO") {
    super(code);
    this.name = "ReportBrandingStorageError";
  }
}

function validPersisted(value: unknown): value is PersistedBranding {
  if (!record(value) || Object.keys(value).some((key) => !["version", "institution_name", "division_name", "logo", "updated_at"].includes(key)) ||
      value.version !== 1 || typeof value.institution_name !== "string" || !value.institution_name.trim() || value.institution_name.length > 160 ||
      typeof value.division_name !== "string" || value.division_name.length > 160 || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at)) ||
      /[\u0000-\u001f\u007f]/.test(value.institution_name) || /[\u0000-\u001f\u007f]/.test(value.division_name)) return false;
  return value.logo === null || record(value.logo) && Object.keys(value.logo).length === 2 &&
    ((value.logo.filename === PNG_FILENAME && value.logo.mime_type === "image/png") ||
     (value.logo.filename === JPEG_FILENAME && value.logo.mime_type === "image/jpeg"));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
