/**
 * Fail-closed guard for legacy Edge application writes after P13 authority moves.
 * Supabase Auth, Realtime reads, and the backend's narrow shadow projector do not
 * call this legacy Edge mutation surface and remain unchanged.
 */
export function legacyApplicationMutationBlocked(): boolean {
  return Deno.env.get("PERSISTENCE_AUTHORITY")?.trim() === "local_postgres";
}

export function legacyApplicationMutationBlockedResponse(
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({
    error: "Legacy Supabase application mutation is disabled",
    code: "LEGACY_MUTATION_BLOCKED",
  }), {
    status: 409,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
