import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const VERSION = "v1";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;

export function validLocalPassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 8 && password.length <= 128 &&
    Buffer.byteLength(password, "utf8") <= 512 && !password.includes("\0");
}

export async function createPasswordRecord(password: string): Promise<string> {
  if (!validLocalPassword(password)) throw new Error("Invalid local password");
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt$${VERSION}$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPasswordRecord(password: string, record: string): Promise<boolean> {
  if (!validLocalPassword(password)) return false;
  const parts = record.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== VERSION ||
      parts[2] !== String(COST) || parts[3] !== String(BLOCK_SIZE) || parts[4] !== String(PARALLELIZATION)) return false;
  try {
    const salt = Buffer.from(parts[5]!, "base64url");
    const expected = Buffer.from(parts[6]!, "base64url");
    if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY_BYTES,
    }, (error, derived) => error ? reject(error) : resolve(derived));
  });
}
