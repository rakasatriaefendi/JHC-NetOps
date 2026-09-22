"use server";

import { requireApprovedProfile } from "@/lib/auth";
import {
  applicationAuthority,
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
  const { supabase } = await requireApprovedProfile();
  const authority = applicationAuthority();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(runnerId)) return { ok: false, authority, data: null };
  if (authority === "local_postgres") {
    const session = await localDeviceInspection(runnerId);
    return { ok: true, authority, data: session as DeviceInspectionSession | null };
  }
  const { data, error } = await supabase.from("device_inspection_sessions")
    .select("*").eq("runner_id", runnerId).maybeSingle<DeviceInspectionSession>();
  return error ? { ok: false, authority, data: null } : { ok: true, authority, data };
}
