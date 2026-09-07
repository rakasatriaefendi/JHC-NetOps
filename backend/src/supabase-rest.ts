const SAFE_DATABASE_ERROR_CODE = /^[a-z0-9_]{1,32}$/i;

type QueryValue = string | number | boolean;

export type SupabaseRequestOptions = Readonly<{
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  prefer?: string;
  signal: AbortSignal;
}>;

export class SupabaseRestClient {
  readonly #baseUrl: string;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.#baseUrl = supabaseUrl.replace(/\/$/, "");
    this.#headers = Object.freeze({
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      "Content-Type": "application/json",
    });
  }

  async table<T>(table: string, options: SupabaseRequestOptions): Promise<T> {
    return this.#request<T>(`rest/v1/${table}`, options);
  }

  async rpc<T>(name: string, body: unknown, signal: AbortSignal): Promise<T> {
    return this.#request<T>(`rest/v1/rpc/${name}`, { method: "POST", body, signal });
  }

  async #request<T>(path: string, options: SupabaseRequestOptions): Promise<T> {
    const url = new URL(`${this.#baseUrl}/${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.prefer ? { ...this.#headers, Prefer: options.prefer } : this.#headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal,
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const payload: unknown = await response.json();
        if (isRecord(payload) && typeof payload.code === "string" && SAFE_DATABASE_ERROR_CODE.test(payload.code)) {
          code = payload.code;
        }
      } catch {}
      throw new SupabaseRestError(response.status, code);
    }
    if (response.status === 204) return null as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }
}

export class SupabaseRestError extends Error {
  constructor(readonly status: number, readonly databaseCode: string | null) {
    super("Supabase persistence request failed");
    this.name = "SupabaseRestError";
  }
}

export function firstRow<T>(value: unknown): T | null {
  return Array.isArray(value) && value.length ? value[0] as T : null;
}

export function inFilter(values: readonly (string | number)[]): string {
  return `in.(${values.join(",")})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
