/** Existing profiles.full_name bound, shared by the self-profile form and action. */
export function normalizeProfileName(value: unknown): string | null {
  if (typeof value !== "string" || /[\p{Cc}<>]/u.test(value)) return null;
  const name = value.trim();
  return name.length > 0 && name.length <= 200 ? name : null;
}

// Display labels remain bounded and never surface secret-shaped historical names.
const SECRET_SHAPE = /(?:^|[^a-z0-9_])(?:bearer[ \t]+\S+|(?:password|passwd|auth_password|priv_password|community|authorization|session_token|access_token|refresh_token|api_key|apikey|client_secret|private_key|database_url|service_role|secret)["']?[ \t]*[:=])/i;
function label(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value.length > limit || /[\p{Cc}<>]/u.test(value) || SECRET_SHAPE.test(value)) return null;
  return value.trim() || null;
}

export function profileDisplayLabel(name: unknown, email: unknown, id: string | null, unavailable = "-"): string {
  return label(name, 200) ?? label(email, 320) ?? id ?? unavailable;
}

export function profileInitials(name: unknown, email: unknown): string | null {
  const displayName = label(name, 200);
  if (displayName) {
    const parts = displayName.split(/\s+/u);
    return (Array.from(parts[0]!)[0]! + (parts.length > 1 ? Array.from(parts[parts.length - 1]!)[0]! : "")).toUpperCase();
  }
  const address = label(email, 320);
  return address ? Array.from(address)[0]!.toUpperCase() : null;
}
