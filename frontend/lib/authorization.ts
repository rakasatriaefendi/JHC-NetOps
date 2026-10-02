export const PROFILE_ROLES = ["admin", "operator", "viewer"] as const;
export const ACCESS_STATUSES = ["pending", "active", "suspended"] as const;

export type ProfileRole = (typeof PROFILE_ROLES)[number];
export type ProfileStatus = "pending" | "approved" | "rejected" | "disabled";
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export function isActiveUser(status: ProfileStatus) {
  return status === "approved";
}

export function canOperateNetwork(role: ProfileRole) {
  return role === "admin" || role === "operator";
}

export function canAdministerUsers(role: ProfileRole) {
  return role === "admin";
}

export function isProfileRole(value: string): value is ProfileRole {
  return PROFILE_ROLES.includes(value as ProfileRole);
}

export function isAccessStatus(value: string): value is AccessStatus {
  return ACCESS_STATUSES.includes(value as AccessStatus);
}

export function accessStatusFromProfile(status: ProfileStatus): AccessStatus | "disabled" {
  if (status === "disabled") return "disabled";
  return status === "approved" ? "active" : status === "rejected" ? "suspended" : "pending";
}

/** UI affordances only; repository authorization remains authoritative. */
export function accountLifecycleAction(status: ProfileStatus, isCurrentUser: boolean): "disable" | "reenable" | "delete" | null {
  if (isCurrentUser) return null;
  return status === "approved" ? "disable" : status === "disabled" ? "reenable" : status === "pending" ? "delete" : null;
}
