"use server";

import { revalidatePath } from "next/cache";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import { cancelAssetScan, loadAssetChangeHistory, loadAssetScanState, requestAssetScan } from "@/lib/assets";
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

export async function getAssetChangeHistoryAction(assetId: string, page = 1) {
  await requireApprovedProfile();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId) ||
      !Number.isSafeInteger(page) || page < 1) {
    return { data: null, error: "unavailable" as const };
  }
  return loadAssetChangeHistory({ page: String(page), page_size: "10" }, assetId);
}
