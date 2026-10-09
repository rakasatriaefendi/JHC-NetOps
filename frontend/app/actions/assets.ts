"use server";

import { revalidatePath } from "next/cache";

import { requireApprovedProfile, requireOperatorProfile } from "@/lib/auth";
import { cancelAssetScan, createScanNetwork, deleteScanNetwork, loadAssetChangeHistory, loadAssetIdentity, loadAssetScanState, loadDetectedScanNetworks, loadScanNetworks, requestAssetScan, testScanNetwork, updateScanNetwork } from "@/lib/assets";
import type { AssetScanMode } from "@/lib/asset-scan-contract";

export async function getAssetScanStateAction() {
  await requireApprovedProfile();
  return loadAssetScanState();
}

export async function getAssetIdentityAction(assetId: string) {
  await requireApprovedProfile();
  if (typeof assetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assetId)) {
    return { data: null, error: "unavailable" as const };
  }
  return loadAssetIdentity(assetId);
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

export async function getScanNetworksAction() {
  await requireApprovedProfile();
  return loadScanNetworks();
}

export async function getDetectedScanNetworksAction() {
  await requireApprovedProfile();
  return loadDetectedScanNetworks();
}

export async function testScanNetworkAction(cidr: string) {
  await requireOperatorProfile();
  return testScanNetwork(cidr);
}

export async function createScanNetworkAction(name: string, cidr: string, origin: "manual" | "detected" = "manual") {
  await requireOperatorProfile();
  const result = await createScanNetwork(name, cidr, origin);
  if (result.ok) revalidatePath("/assets");
  return result;
}

export async function updateScanNetworkAction(id: string, change: { name?: string | null; enabled?: boolean }) {
  await requireOperatorProfile();
  const result = await updateScanNetwork(id, change);
  if (result.ok) revalidatePath("/assets");
  return result;
}

export async function deleteScanNetworkAction(id: string) {
  await requireOperatorProfile();
  const result = await deleteScanNetwork(id);
  if (result.ok) revalidatePath("/assets");
  return result;
}
