import type { ProfileStatus } from "./authorization.ts";

export function authDestination(status: ProfileStatus): "/dashboard" | "/pending" | "/login" {
  if (status === "disabled") return "/login";
  return status === "approved" ? "/dashboard" : "/pending";
}
