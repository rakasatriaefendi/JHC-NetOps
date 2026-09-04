export const PROFILE_ROLES = ["admin", "operator", "viewer"] as const;
export const ACCESS_STATUSES = ["pending", "active", "suspended"] as const;

export type ProfileRole = (typeof PROFILE_ROLES)[number];
export type ProfileStatus = "pending" | "approved" | "rejected";
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

export function accessStatusFromProfile(status: ProfileStatus): AccessStatus {
  return status === "approved" ? "active" : status === "rejected" ? "suspended" : "pending";
}
