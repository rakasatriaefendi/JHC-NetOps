"use server";

import { requireApprovedProfile } from "@/lib/auth";
import {
  localDeviceInspection,
  type ApplicationAuthority,
} from "@/lib/application-persistence";
import type { DeviceInspectionSession } from "@/lib/device-inspector";

export type DeviceInspectionSessionResult = {
  ok: boolean;
  authority: ApplicationAuthority;
  data: DeviceInspectionSession | null;
};

export async function getDeviceInspectionSessionAction(runnerId: string): Promise<DeviceInspectionSessionResult> {
  await requireApprovedProfile();
  const authority = "local_postgres" as const;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return { ok: false, authority, data: null };
  const session = await localDeviceInspection(runnerId);
  return { ok: true, authority, data: session as DeviceInspectionSession | null };
}
