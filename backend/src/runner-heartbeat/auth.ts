import { createHash, timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";
const MAX_AUTHORIZATION_LENGTH = 1024;

export function validRunnerBearerToken(authorization: unknown, expectedToken: string): boolean {
  if (typeof authorization !== "string" || authorization.length > MAX_AUTHORIZATION_LENGTH ||
      !authorization.startsWith(BEARER_PREFIX)) return false;
  const providedToken = authorization.slice(BEARER_PREFIX.length);
  if (!providedToken || /[\r\n]/.test(providedToken)) return false;
  const providedDigest = createHash("sha256").update(providedToken, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expectedToken, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}
