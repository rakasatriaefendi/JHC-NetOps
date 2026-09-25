const SAFE_FALLBACK_ORIGIN = "http://localhost";

export function configuredAuthPublicOrigin(
  configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string | null {
  if (!configuredSiteUrl) return null;
  return validConfiguredOrigin(configuredSiteUrl.trim())?.origin ?? null;
}

export function resolveAuthRedirectOrigin(
  requestUrl: string | URL,
  headers: Pick<Headers, "get">,
  configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  const configured = configuredAuthPublicOrigin(configuredSiteUrl);
  const configuredUrl = configured ? new URL(configured) : null;
  const requestOrigin = validRequestOrigin(requestUrl);

  if (configuredUrl && (
    sameHostHeader(headers.get("host"), configuredUrl) ||
    trustedForwardedOrigin(headers, configuredUrl) ||
    (requestOrigin && sameOriginHost(requestOrigin, configuredUrl))
  )) return configuredUrl.origin;

  if (requestOrigin && privateOrLoopbackHost(requestOrigin.hostname)) {
    return requestOrigin.origin;
  }

  return configuredUrl?.origin ?? SAFE_FALLBACK_ORIGIN;
}

function trustedForwardedOrigin(headers: Pick<Headers, "get">, configured: URL): boolean {
  const protocol = singleHeaderValue(headers.get("x-forwarded-proto"));
  return protocol === configured.protocol.slice(0, -1) &&
    sameHostHeader(headers.get("x-forwarded-host"), configured);
}

function sameHostHeader(value: string | null, configured: URL): boolean {
  const host = singleHeaderValue(value);
  if (!host || /[\s/@?#\\]/.test(host)) return false;
  try {
    const parsed = new URL(`${configured.protocol}//${host}`);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/" &&
      parsed.search === "" && parsed.hash === "" && parsed.host === configured.host;
  } catch {
    return false;
  }
}

function singleHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized.includes(",") ? null : normalized;
}

function validConfiguredOrigin(value: string | URL): URL | null {
  try {
    const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function validRequestOrigin(value: string | URL): URL | null {
  try {
    const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return null;
    return new URL(parsed.origin);
  } catch {
    return null;
  }
}

function sameOriginHost(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.host === right.host;
}

function privateOrLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const values = octets.map(Number);
  if (values.some((part) => part < 0 || part > 255)) return false;
  return values[0] === 10 || values[0] === 127 ||
    (values[0] === 172 && values[1] >= 16 && values[1] <= 31) ||
    (values[0] === 192 && values[1] === 168);
}
