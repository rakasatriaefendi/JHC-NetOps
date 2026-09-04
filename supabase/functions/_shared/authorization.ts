export function canOperateNetwork(role: unknown): boolean {
  return role === "admin" || role === "operator";
}
