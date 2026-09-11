import { notFound } from "next/navigation";

import { MedicalEquipmentDetail } from "@/components/medical-equipment/medical-equipment-detail";
import { getServerTranslation } from "@/i18n/server";
import { requireApprovedProfile } from "@/lib/auth";
import { canOperateNetwork } from "@/lib/authorization";
import { loadMedicalEquipment, loadMedicalEquipmentDetail } from "@/lib/medical-equipment";

export const dynamic = "force-dynamic";

export default async function MedicalEquipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ profile }, { id }, { locale, t }] = await Promise.all([requireApprovedProfile(), params, getServerTranslation("medical")]);
  const [result, list] = await Promise.all([loadMedicalEquipmentDetail(id), loadMedicalEquipment({ page_size: "10" })]);
  if (!result.data && result.error === "MEDICAL_EQUIPMENT_NOT_FOUND") notFound();
  if (!result.data) return <main className="p-4 md:p-6"><section className="rounded-panel border border-border bg-bg-surface p-6">{t("errors.unavailable")}</section></main>;
  return <main className="p-4 md:p-6"><MedicalEquipmentDetail detail={result.data} canManage={canOperateNetwork(profile.role)} departments={list.data?.filters.departments ?? []} locations={list.data?.filters.locations ?? []} locale={locale} /></main>;
}
