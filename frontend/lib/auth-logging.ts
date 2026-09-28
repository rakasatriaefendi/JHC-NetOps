type AuthOperation = "login" | "register";

export type SafeAuthFailure = {
  operation: AuthOperation;
  code: string;
  status: number | null;
};

export function safeAuthFailure(operation: AuthOperation, error: unknown): SafeAuthFailure {
  const candidate = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown }
    : {};
  return {
    operation,
    code: boundedCode(candidate.code),
    status: safeStatus(candidate.status),
  };
}

export function logAuthFailure(operation: AuthOperation, error: unknown) {
  console.error("Authentication failed", safeAuthFailure(operation, error));
}

function boundedCode(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(value)) return "auth_failed";
  return value;
}

function safeStatus(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 400 && Number(value) <= 599
    ? Number(value)
    : null;
}
