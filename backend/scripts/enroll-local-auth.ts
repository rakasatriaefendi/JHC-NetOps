import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { Pool } from "pg";

import { parseDedicatedPostgresUrl } from "../src/config.js";
import { LocalAuthError, PostgresLocalAuthRepository } from "../src/local-auth/repository.js";
import { validLocalPassword } from "../src/local-auth/password.js";
import { PoolPostgresQuery } from "../src/persistence/postgres-query.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 15_000;

type EnrollmentArguments = Readonly<{ profileId: string; email: string; rotate: boolean }>;

export function parseEnrollmentArguments(values: readonly string[]): EnrollmentArguments {
  let profileId: string | null = null;
  let email: string | null = null;
  let rotate = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--rotate" && !rotate) {
      rotate = true;
      continue;
    }
    if ((value === "--profile-id" || value === "--email") && typeof values[index + 1] === "string") {
      const supplied = values[index + 1]!;
      if (value === "--profile-id" && profileId === null) profileId = supplied;
      else if (value === "--email" && email === null) email = supplied;
      else throw new EnrollmentCliError("INVALID_ARGUMENTS");
      index += 1;
      continue;
    }
    throw new EnrollmentCliError("INVALID_ARGUMENTS");
  }
  const normalizedEmail = email?.trim().toLowerCase() ?? "";
  if (!profileId || !UUID.test(profileId) || normalizedEmail.length < 3 || normalizedEmail.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new EnrollmentCliError("INVALID_ARGUMENTS");
  }
  return { profileId: profileId.toLowerCase(), email: normalizedEmail, rotate };
}

async function main(): Promise<void> {
  const args = parseEnrollmentArguments(process.argv.slice(2));
  const configuredUrl = process.env.APPLICATION_DATABASE_URL?.trim();
  if (!configuredUrl) throw new EnrollmentCliError("DATABASE_CONFIGURATION_REQUIRED");
  const connectionString = parseDedicatedPostgresUrl(configuredUrl);
  const password = await readHiddenPassword("New local password: ");
  const confirmation = await readHiddenPassword("Confirm local password: ");
  if (!validLocalPassword(password) || password !== confirmation) throw new EnrollmentCliError("PASSWORD_INVALID");

  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 3_000,
    statement_timeout: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS + 1_000,
    application_name: "jhc-netops-local-auth-enrollment",
  });
  try {
    const result = await new PostgresLocalAuthRepository(new PoolPostgresQuery(pool)).enrollExistingCredential(
      args.profileId, args.email, password, args.rotate, AbortSignal.timeout(TIMEOUT_MS),
    );
    process.stdout.write(`${JSON.stringify({ status: "ok", profile_id: args.profileId, credential: result })}\n`);
  } finally {
    await pool.end();
  }
}

async function readHiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new EnrollmentCliError("INTERACTIVE_TTY_REQUIRED");
  }
  process.stdout.write(prompt);
  return new Promise((resolvePassword, rejectPassword) => {
    let password = "";
    const finish = (error?: EnrollmentCliError) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectPassword(error);
      else resolvePassword(password);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new EnrollmentCliError("INTERRUPTED"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          password = Array.from(password).slice(0, -1).join("");
        } else if (character >= " ") {
          password += character;
          if (Buffer.byteLength(password, "utf8") > 512) return finish(new EnrollmentCliError("PASSWORD_INVALID"));
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

class EnrollmentCliError extends Error {
  constructor(readonly code: "INVALID_ARGUMENTS" | "DATABASE_CONFIGURATION_REQUIRED" | "INTERACTIVE_TTY_REQUIRED" |
    "PASSWORD_INVALID" | "INTERRUPTED") {
    super("Local Auth enrollment failed");
    this.name = "EnrollmentCliError";
  }
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof EnrollmentCliError || error instanceof LocalAuthError
      ? error.code
      : "LOCAL_AUTH_ENROLLMENT_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
    process.exitCode = 1;
  }
}
