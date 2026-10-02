export function authDestination(status: "pending" | "approved" | "rejected"): "/dashboard" | "/pending" {
  return status === "approved" ? "/dashboard" : "/pending";
}
