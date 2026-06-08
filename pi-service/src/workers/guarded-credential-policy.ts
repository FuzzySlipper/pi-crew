import type { WorkerPolicy } from "@pi-crew/core";
import { isCredentialAccessAllowed, type CredentialAccessLevel } from "@pi-crew/tools";

interface CredentialCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

const ACCESS_KEYS = new Set([
  "credentialAccess",
  "credentialScope",
  "credentialMode",
  "credentialUse",
  "requestedCredentialScope",
]);

const WRITE_ACTIONS = new Set(["write", "create", "update", "delete", "mutate", "post", "put", "patch"]);

export function checkCredentialPolicy(policy: WorkerPolicy, args: unknown): CredentialCheckResult {
  if (!isPolicyScopeValid(policy)) {
    return { allowed: false, reason: "Worker policy has missing or unknown credential scope" };
  }

  const requested = findCredentialAccess(args);
  if (requested === null) {
    return { allowed: true, reason: "" };
  }

  if (!isCredentialAccessAllowed(policy, requested)) {
    return {
      allowed: false,
      reason: `Credential access '${requested}' exceeds worker policy scope '${policy.credentialScope}'`,
    };
  }

  return { allowed: true, reason: "" };
}

function isPolicyScopeValid(policy: WorkerPolicy): boolean {
  return isCredentialAccessAllowed(policy, "none") || policy.credentialScope === "none";
}

function findCredentialAccess(value: unknown): CredentialAccessLevel | null {
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) return findArrayCredentialAccess(value);

  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    const direct = credentialAccessFromEntry(key, entry);
    if (direct !== null) return direct;
    const nested = findCredentialAccess(entry);
    if (nested !== null) return nested;
  }
  return null;
}

function findArrayCredentialAccess(values: readonly unknown[]): CredentialAccessLevel | null {
  for (const value of values) {
    const nested = findCredentialAccess(value);
    if (nested !== null) return nested;
  }
  return null;
}

function credentialAccessFromEntry(key: string, value: unknown): CredentialAccessLevel | null {
  if (ACCESS_KEYS.has(key) && typeof value === "string") return normalizeRequestedAccess(value);
  if (key === "requiresCredentials" && value === true) return "read_only";
  if ((key === "credentialWrite" || key === "requiresCredentialWrite") && value === true) return "bounded_write";
  if ((key === "operation" || key === "method") && typeof value === "string" && WRITE_ACTIONS.has(value.toLowerCase())) {
    return "bounded_write";
  }
  return null;
}

function normalizeRequestedAccess(value: string): CredentialAccessLevel {
  if (value === "none" || value === "read_only" || value === "bounded_write" || value === "full") {
    return value;
  }
  return "full";
}
