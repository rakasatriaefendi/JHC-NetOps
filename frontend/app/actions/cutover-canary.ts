"use server";

import { requireAdminProfile } from "@/lib/auth";
import { localApplicationRequest } from "@/lib/application-persistence";

/**
 * Internal cutover canary server action.
 * This is the ONLY authorized write path for the P13 internal cutover canary.
 * It must:
 * - Use the approved backend application path (local application API)
 * - Prove a local commit (write + read-after-write)
 * - Create ZERO domain rows
 * - Clean itself up
 */
export async function executeCutoverCanary(): Promise<{
  ok: boolean;
  error?: string;
  canaryId?: string;
  writeOk?: boolean;
  readOk?: boolean;
  cleanupOk?: boolean;
}> {
  await requireAdminProfile();
  const cutoverIdentity = `p13-cutover-${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
  const payload = { test: "internal-cutover-canary", timestamp: new Date().toISOString() };
  let canaryId: string | undefined;
  let outcome: Awaited<ReturnType<typeof executeCutoverCanary>> = { ok: false, error: "Canary did not complete" };

  // Admin is established above. The browser never receives LOCAL_BACKEND_TOKEN;
  // this server action crosses the bounded shared-token backend trust boundary.
  try {
    const writeResult = await localApplicationRequest("POST", "/api/application/cutover-canary", {
      cutover_identity: cutoverIdentity,
      payload,
    });
    if (!writeResult.ok) return { ok: false, error: `Write failed: ${writeResult.code}` };
    const writeData = writeResult.data as { id?: string } | null;
    canaryId = writeData?.id;
    if (!canaryId) return { ok: false, error: "Write succeeded but no canary ID returned" };

    const readResult = await localApplicationRequest("GET",
      `/api/application/cutover-canary/${canaryId}?cutover_identity=${encodeURIComponent(cutoverIdentity)}`);
    const readData = readResult.data as { id?: string } | null;
    if (!readResult.ok || readData?.id !== canaryId) {
      outcome = { ok: false, error: `Read failed: ${readResult.code}`, canaryId, writeOk: true };
      return outcome;
    }

    const verifyResult = await localApplicationRequest("PATCH", `/api/application/cutover-canary/${canaryId}/verify`, {
      cutover_identity: cutoverIdentity,
    });
    if (!verifyResult.ok) {
      outcome = { ok: false, error: `Verify failed: ${verifyResult.code}`, canaryId, writeOk: true, readOk: true };
      return outcome;
    }
    const verifiedRead = await localApplicationRequest("GET",
      `/api/application/cutover-canary/${canaryId}?cutover_identity=${encodeURIComponent(cutoverIdentity)}`);
    const verifiedData = verifiedRead.data as { id?: string; verified_at?: string | null } | null;
    outcome = verifiedRead.ok && verifiedData?.id === canaryId && typeof verifiedData.verified_at === "string"
      ? { ok: true, canaryId, writeOk: true, readOk: true }
      : { ok: false, error: "Verified row could not be observed", canaryId, writeOk: true, readOk: true };
    return outcome;
  } finally {
    if (canaryId) {
      const cleanup = await localApplicationRequest("DELETE", `/api/application/cutover-canary/${canaryId}`, {
        cutover_identity: cutoverIdentity,
      });
      if (cleanup.ok) outcome.cleanupOk = true;
      else {
        outcome.ok = false;
        outcome.cleanupOk = false;
        outcome.error = `Cleanup failed: ${cleanup.code}`;
      }
    }
  }
}
