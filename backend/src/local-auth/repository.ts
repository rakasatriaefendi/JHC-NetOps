import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PostgresQuery, PostgresTransactionalQuery } from "../persistence/postgres-query.js";
import { createPasswordRecord, validLocalPassword, verifyPasswordRecord } from "./password.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LocalAuthProfile = Readonly<{
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "operator" | "viewer";
  status: "pending" | "approved" | "rejected" | "disabled";
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
}>;

export type LocalAuthSession = Readonly<{
  token: string;
  expires_at: string;
  profile: LocalAuthProfile;
}>;

export class LocalAuthError extends Error {
  constructor(readonly code: "INVALID_AUTH_REQUEST" | "INVALID_CREDENTIALS" |
    "ACCOUNT_EXISTS" | "ACCOUNT_ENROLLMENT_REQUIRED" | "SESSION_INVALID" |
    "PROFILE_NOT_FOUND" | "PROFILE_EMAIL_MISMATCH" | "CREDENTIAL_EXISTS" | "ACCOUNT_DISABLED") {
    super("Local authentication request failed");
    this.name = "LocalAuthError";
  }
}

export class PostgresLocalAuthRepository {
  constructor(private readonly database: PostgresTransactionalQuery) {}

  async enrollExistingCredential(profileId: string, expectedEmailValue: string, password: string,
    rotate: boolean, signal: AbortSignal): Promise<"created" | "rotated"> {
    const expectedEmail = normalizedEmail(expectedEmailValue);
    if (!UUID.test(profileId) || !expectedEmail || !validLocalPassword(password)) {
      throw new LocalAuthError("INVALID_AUTH_REQUEST");
    }
    const normalizedProfileId = profileId.toLowerCase();
    const passwordRecord = await createPasswordRecord(password);
    return this.database.transaction(signal, async (query) => {
      const profiles = await query.rows(
        "SELECT id,email FROM public.profiles WHERE id=$1::uuid FOR UPDATE", [normalizedProfileId], signal,
      );
      const profile = profiles[0];
      if (!profile) throw new LocalAuthError("PROFILE_NOT_FOUND");
      if (typeof profile.email !== "string" || normalizedEmail(profile.email) !== expectedEmail) {
        throw new LocalAuthError("PROFILE_EMAIL_MISMATCH");
      }
      const credentials = await query.rows(`
        SELECT user_id,email FROM public.local_auth_credentials
        WHERE user_id=$1::uuid OR email=$2
        FOR UPDATE
      `, [normalizedProfileId, expectedEmail], signal);
      if (credentials.some((credential) => credential.user_id !== normalizedProfileId)) {
        throw new LocalAuthError("ACCOUNT_EXISTS");
      }
      const credential = credentials.find((candidate) => candidate.user_id === normalizedProfileId);
      if (credential && !rotate) throw new LocalAuthError("CREDENTIAL_EXISTS");
      if (credential) {
        await query.rows(`
          UPDATE public.local_auth_credentials
          SET email=$2,password_record=$3,updated_at=now()
          WHERE user_id=$1::uuid
        `, [normalizedProfileId, expectedEmail, passwordRecord], signal);
        return "rotated";
      }
      await query.rows(`
        INSERT INTO public.local_auth_credentials(user_id,email,password_record)
        VALUES ($1::uuid,$2,$3)
      `, [normalizedProfileId, expectedEmail, passwordRecord], signal);
      return "created";
    });
  }

  async register(emailValue: string, password: string, fullNameValue: string, signal: AbortSignal): Promise<LocalAuthSession> {
    const email = normalizedEmail(emailValue);
    const fullName = fullNameValue.trim();
    if (!email || !validLocalPassword(password) || fullName.length < 2 || fullName.length > 200 || control(fullName)) {
      throw new LocalAuthError("INVALID_AUTH_REQUEST");
    }
    const passwordRecord = await createPasswordRecord(password);
    const userId = randomUUID();
    const session = newSession();
    return this.database.transaction(signal, async (query) => {
      const existingCredential = await query.rows(
        "SELECT user_id FROM public.local_auth_credentials WHERE email=$1", [email], signal,
      );
      if (existingCredential.length > 0) throw new LocalAuthError("ACCOUNT_EXISTS");
      const existingProfile = await query.rows(
        "SELECT id FROM public.profiles WHERE lower(email)=lower($1) LIMIT 1", [email], signal,
      );
      // Email knowledge is not proof that the caller owns an existing approved profile.
      if (existingProfile.length > 0) throw new LocalAuthError("ACCOUNT_ENROLLMENT_REQUIRED");
      const rows = await query.rows(`
        INSERT INTO public.profiles(id,email,full_name,role,status)
        VALUES ($1::uuid,$2,$3,'viewer','pending')
        RETURNING id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
      `, [userId, email, fullName], signal);
      await query.rows(`
        INSERT INTO public.local_auth_credentials(user_id,email,password_record)
        VALUES ($1::uuid,$2,$3)
      `, [userId, email, passwordRecord], signal);
      await insertSession(query, userId, session, signal);
      const profile = localProfile(rows[0]);
      if (!profile) throw new LocalAuthError("INVALID_AUTH_REQUEST");
      return { token: session.token, expires_at: session.expires_at, profile };
    });
  }

  async login(emailValue: string, password: string, signal: AbortSignal): Promise<LocalAuthSession> {
    const email = normalizedEmail(emailValue);
    if (!email || !validLocalPassword(password)) throw new LocalAuthError("INVALID_CREDENTIALS");
    const rows = await this.database.rows(`
      SELECT c.user_id,c.password_record,p.id,p.email,p.full_name,p.role,p.status,
             p.created_at,p.approved_at,p.approved_by,p.disabled_at,p.disabled_by
      FROM public.local_auth_credentials c
      JOIN public.profiles p ON p.id=c.user_id
      WHERE c.email=$1
      LIMIT 1
    `, [email], signal);
    const row = rows[0];
    const valid = typeof row?.password_record === "string" && await verifyPasswordRecord(password, row.password_record);
    const profile = valid ? localProfile(row) : null;
    if (!profile) throw new LocalAuthError("INVALID_CREDENTIALS");
    if (profile.status === "disabled") throw new LocalAuthError("ACCOUNT_DISABLED");
    const session = newSession();
    const currentProfile = await this.database.transaction(signal, async (query) => {
      // Serialize session creation with lifecycle UPDATE/DELETE on this profile.
      // A login verified just before disable must not recreate a revoked session.
      const profiles = await query.rows(`
        SELECT id,email,full_name,role,status,created_at,approved_at,approved_by,disabled_at,disabled_by
        FROM public.profiles WHERE id=$1::uuid FOR SHARE
      `, [profile.id], signal);
      const current = localProfile(profiles[0]);
      if (!current) throw new LocalAuthError("INVALID_CREDENTIALS");
      if (current.status === "disabled") throw new LocalAuthError("ACCOUNT_DISABLED");
      await query.rows("DELETE FROM public.local_auth_sessions WHERE expires_at <= now()", [], signal);
      await insertSession(query, profile.id, session, signal);
      return current;
    });
    return { token: session.token, expires_at: session.expires_at, profile: currentProfile };
  }

  async resolve(token: string, signal: AbortSignal): Promise<LocalAuthProfile> {
    const digest = sessionDigest(token);
    if (!digest) throw new LocalAuthError("SESSION_INVALID");
    const rows = await this.database.rows(`
      SELECT p.id,p.email,p.full_name,p.role,p.status,p.created_at,p.approved_at,p.approved_by,p.disabled_at,p.disabled_by
      FROM public.local_auth_sessions s
      JOIN public.profiles p ON p.id=s.user_id
      WHERE s.token_digest=$1 AND s.expires_at > now()
      LIMIT 1
    `, [digest], signal);
    const profile = localProfile(rows[0]);
    if (!profile || profile.status === "disabled") throw new LocalAuthError("SESSION_INVALID");
    return profile;
  }

  async logout(token: string, signal: AbortSignal): Promise<void> {
    const digest = sessionDigest(token);
    if (!digest) return;
    await this.database.rows("DELETE FROM public.local_auth_sessions WHERE token_digest=$1", [digest], signal);
  }
}

type SessionMaterial = Readonly<{ token: string; expires_at: string; digest: Buffer }>;

function newSession(): SessionMaterial {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    digest: createHash("sha256").update(token, "utf8").digest(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
}

async function insertSession(query: PostgresQuery, userId: string, session: SessionMaterial, signal: AbortSignal): Promise<void> {
  await query.rows(`
    DELETE FROM public.local_auth_sessions
    WHERE user_id=$1::uuid AND token_digest IN (
      SELECT token_digest FROM public.local_auth_sessions
      WHERE user_id=$1::uuid ORDER BY created_at DESC,token_digest OFFSET 4
    )
  `, [userId], signal);
  await query.rows(`
    INSERT INTO public.local_auth_sessions(token_digest,user_id,expires_at)
    VALUES ($1,$2::uuid,$3::timestamptz)
  `, [session.digest, userId, session.expires_at], signal);
}

function sessionDigest(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest();
}

function normalizedEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 320 && EMAIL.test(email) && !control(email) ? email : null;
}

function control(value: string): boolean { return /[\u0000-\u001f\u007f]/.test(value); }

function localProfile(value: Record<string, unknown> | undefined): LocalAuthProfile | null {
  if (!value || typeof value.id !== "string" || typeof value.email !== "string" ||
      !["admin", "operator", "viewer"].includes(String(value.role)) ||
      !["pending", "approved", "rejected", "disabled"].includes(String(value.status))) return null;
  return {
    id: value.id,
    email: value.email,
    full_name: typeof value.full_name === "string" ? value.full_name : null,
    role: value.role as LocalAuthProfile["role"],
    status: value.status as LocalAuthProfile["status"],
    created_at: iso(value.created_at),
    approved_at: value.approved_at ? iso(value.approved_at) : null,
    approved_by: typeof value.approved_by === "string" ? value.approved_by : null,
    disabled_at: value.disabled_at ? iso(value.disabled_at) : null,
    disabled_by: typeof value.disabled_by === "string" ? value.disabled_by : null,
  };
}

function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
