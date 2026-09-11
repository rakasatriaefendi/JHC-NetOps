import { MedicalEquipmentRegistry } from "@/components/medical-equipment/medical-equipment-registry";
import { requireApprovedProfile } from "@/lib/auth";
import { canOperateNetwork } from "@/lib/authorization";
import { loadMedicalEquipment } from "@/lib/medical-equipment";
import type { MedicalListParams } from "@/lib/medical-equipment-contract";

export const dynamic = "force-dynamic";

export default async function MedicalEquipmentPage({ searchParams }: { searchParams: Promise<Partial<MedicalListParams>> }) {
  const { profile } = await requireApprovedProfile();
  const query = await searchParams;
  const result = await loadMedicalEquipment(query);
  return <main className="p-4 md:p-6"><MedicalEquipmentRegistry data={result.data} error={result.error} query={query} canManage={canOperateNetwork(profile.role)} /></main>;
}
