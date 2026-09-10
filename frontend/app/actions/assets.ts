"use server";

import { revalidatePath } from "next/cache";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import { cancelAssetScan, loadAssetScanState, requestAssetScan } from "@/lib/assets";
import type { AssetScanMode } from "@/lib/asset-scan-contract";

export async function getAssetScanStateAction() {
  await requireApprovedProfile();
  return loadAssetScanState();
}

export async function startAssetScanAction(mode: AssetScanMode, network: string) {
  await requireOperatorProfile();
  if ((mode !== "quick" && mode !== "deep") || typeof network !== "string" || network.length > 32) {
    return { data: null, error: "INVALID_SCAN_REQUEST" };
  }
  const result = await requestAssetScan(mode, network);
  if (!result.error) revalidatePath("/assets");
  return result;
}

export async function cancelAssetScanAction(id: string) {
  await requireOperatorProfile();
  const result = await cancelAssetScan(id);
  revalidatePath("/assets");
  return result;
}
