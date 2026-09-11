"use server";

import { revalidatePath } from "next/cache";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import {
  createCalibration,
  createMedicalEquipment,
  createService,
  searchMedicalNetworkAssets,
  updateMedicalEquipment,
} from "@/lib/medical-equipment";
import type { CalibrationRecord, MedicalEquipmentInput, ServiceRecord } from "@/lib/medical-equipment-contract";

export async function createMedicalEquipmentAction(input: MedicalEquipmentInput) {
  await requireOperatorProfile();
  const result = await createMedicalEquipment(input);
  if (result.data) revalidatePath("/medical-equipment");
  return result;
}
export async function updateMedicalEquipmentAction(id: string, input: MedicalEquipmentInput) {
  await requireOperatorProfile();
  const result = await updateMedicalEquipment(id, input);
  if (result.data) { revalidatePath("/medical-equipment"); revalidatePath(`/medical-equipment/${id}`); revalidatePath("/assets"); }
  return result;
}
export async function createCalibrationAction(id: string, input: Omit<CalibrationRecord, "id" | "record_number" | "created_at" | "updated_at">) {
  await requireOperatorProfile();
  const result = await createCalibration(id, input);
  if (result.data) { revalidatePath("/medical-equipment"); revalidatePath(`/medical-equipment/${id}`); }
  return result;
}
export async function createServiceAction(id: string, input: Omit<ServiceRecord, "id" | "record_number" | "created_at" | "updated_at">) {
  await requireOperatorProfile();
  const result = await createService(id, input);
  if (result.data) { revalidatePath("/medical-equipment"); revalidatePath(`/medical-equipment/${id}`); }
  return result;
}
export async function searchMedicalNetworkAssetsAction(search: string) {
  await requireApprovedProfile();
  return searchMedicalNetworkAssets(typeof search === "string" ? search.slice(0, 100) : "");
}
