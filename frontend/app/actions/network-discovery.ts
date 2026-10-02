"use server";

import { localNetworkDiscovery, localRunners, type ApplicationAuthority } from "@/lib/application-persistence";
import { requireApprovedProfile } from "@/lib/auth";
import { normalizeDiscoveryRunners, type DiscoveryRunner, type DiscoverySession } from "@/lib/network-discovery-client";

export type DiscoveryRunnersResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: DiscoveryRunner[];
};

export async function getDiscoveryRunnersAction(): Promise<DiscoveryRunnersResult> {
  await requireApprovedProfile();
  const authority = "local_postgres" as const;
  const rows = await localRunners();
  return rows
    ? { ok: true, authority, data: normalizeDiscoveryRunners(rows) }
    : { ok: false, authority, data: [] };
}

export type DiscoverySessionResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: DiscoverySession | null;
};

export async function getDiscoverySessionAction(runnerId: string): Promise<DiscoverySessionResult> {
  await requireApprovedProfile();
  const authority = "local_postgres" as const;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return { ok: false, authority, data: null };
  const session = await localNetworkDiscovery(runnerId);
  return { ok: true, authority, data: session as DiscoverySession | null };
}
