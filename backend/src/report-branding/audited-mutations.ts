import type { PostgresAdministrativeAuditRepository, BrandingAuditAction } from "../persistence/administrative-audit.js";
import { validateReportLogo, type ReportBrandingSnapshot, type ReportBrandingTextInput, type ReportLogoInput } from "./contract.js";
import { ReportBrandingStorageError, type ReportBrandingStore } from "./storage.js";
import { ProfilePersistenceError } from "../persistence/profiles.js";

export class AuditedReportBranding {
  constructor(private readonly store: ReportBrandingStore, private readonly audit: PostgresAdministrativeAuditRepository) {}

  text(actor: string, input: ReportBrandingTextInput, signal: AbortSignal) {
    return this.mutate(actor, "branding_identity_updated", signal,
      (before) => before.branding.institution_name !== input.institutionName || before.branding.division_name !== input.divisionName,
      () => this.store.saveText(input), (after) => after.branding.institution_name === input.institutionName && after.branding.division_name === input.divisionName);
  }
  logo(actor: string, input: ReportLogoInput, signal: AbortSignal) {
    const logo = validateReportLogo(input);
    if (!logo) throw new ReportBrandingStorageError("INVALID_REPORT_LOGO");
    return this.mutate(actor, "branding_logo_updated", signal,
      (before) => before.logo === null || before.logo.mimeType !== logo.mimeType || !before.logo.bytes.equals(logo.bytes),
      () => this.store.saveLogo(input), (after) => after.logo?.mimeType === logo.mimeType && after.logo.bytes.equals(logo.bytes));
  }
  remove(actor: string, signal: AbortSignal) {
    return this.mutate(actor, "branding_logo_removed", signal,
      (before) => before.logo !== null, () => this.store.removeLogo(), (after) => after.logo === null);
  }

  private async mutate(actor: string, action: BrandingAuditAction, signal: AbortSignal,
    meaningful: (before: ReportBrandingSnapshot) => boolean,
    write: () => Promise<unknown>, verified: (after: ReportBrandingSnapshot) => boolean) {
    try {
      return await this.audit.withAdmin(actor, signal, async (query) => {
        // Serialize across backend instances sharing the same branding directory.
        await query.rows("SELECT pg_advisory_xact_lock(17002)", [], signal);
        const before = await this.store.readSnapshot();
        if (!meaningful(before)) return { data: before.branding, changed: false };
        let written = false;
        try {
          written = true;
          await write();
          const after = await this.store.readSnapshot();
          if (!verified(after)) throw new Error("Branding verification failed");
          await this.audit.append(query, actor, action, before.branding, after.branding, signal);
          return { data: after.branding, changed: true };
        } catch {
          // Compensate while the advisory lock is STILL held, never overwrite a
          // later writer after releasing the database transaction lock.
          if (written) await this.store.restoreSnapshot(before);
          throw new Error("Report branding mutation failed");
        }
      });
    } catch (error) {
      // Filesystem and PostgreSQL are NOT a distributed transaction. Process
      // death or ambiguous COMMIT needs operator review, not an unsafe retry.
      if (error instanceof ProfilePersistenceError) throw error;
      throw new Error("Report branding mutation failed");
    }
  }
}
