/**
 * Pure scanner helpers for ExecutionPolicy tool-call enforcement.
 *
 * These functions inspect raw tool-call arguments and tool names, then return
 * policy check results without emitting events, logging, or invoking tools.
 * Service-level orchestration owns denial evidence and wrapper behavior.
 *
 * @module pi-tools/policy-scanner
 */

import type { CredentialAccessLevel, ExecutionPolicy, PolicyCheckResult } from "@pi-crew/core";
import {
  isCredentialAccessAllowed,
  isWithinOrEqual,
  resolvePolicyPath,
} from "./execution-policy.js";

interface CandidatePath {
  readonly raw: string;
  readonly resolved: string;
}

interface HostCandidate {
  readonly raw: string;
  readonly host: string;
}

const PATH_KEYS = new Set([
  "path",
  "file",
  "filePath",
  "filepath",
  "source",
  "sourcePath",
  "destination",
  "destinationPath",
  "target",
  "targetPath",
]);

const HOST_KEYS = new Set([
  "url",
  "uri",
  "endpoint",
  "baseUrl",
  "serverUrl",
  "mcpUrl",
  "host",
  "hostname",
]);

const ACCESS_KEYS = new Set([
  "credentialAccess",
  "credentialScope",
  "credentialMode",
  "credentialUse",
  "requestedCredentialScope",
]);

const WRITE_ACTIONS = new Set(["write", "create", "update", "delete", "mutate", "post", "put", "patch"]);

/** Scan path-like tool arguments against an ExecutionPolicy. */
export function scanPaths(policy: ExecutionPolicy, args: unknown): PolicyCheckResult {
  for (const candidate of collectCandidatePaths(policy.rootPath, args)) {
    const denyRoot = policy.denyPaths.find((deny) =>
      isWithinOrEqual(candidate.resolved, resolvePolicyPath(policy.rootPath, deny)),
    );
    if (denyRoot !== undefined) {
      return {
        allowed: false,
        reason: `Path "${candidate.raw}" is denied by execution policy (${denyRoot})`,
      };
    }

    const allowedRoots = policy.allowedPaths.length > 0
      ? policy.allowedPaths
      : [policy.rootPath];
    const allowed = allowedRoots.some((allowedPath) =>
      isWithinOrEqual(candidate.resolved, resolvePolicyPath(policy.rootPath, allowedPath)),
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: `Path "${candidate.raw}" is outside the execution policy allowed paths`,
      };
    }
  }

  return { allowed: true, reason: "" };
}

/** Scan host/url-like tool arguments against an ExecutionPolicy. */
export function scanHosts(policy: ExecutionPolicy, args: unknown): PolicyCheckResult {
  for (const candidate of collectHostCandidates(args)) {
    const denied = policy.deniedHosts.find((host) => hostMatches(candidate.host, host));
    if (denied !== undefined) {
      return {
        allowed: false,
        reason: `Host "${candidate.raw}" is denied by execution policy (${denied})`,
      };
    }

    if (policy.allowedHosts.length === 0) continue;

    const allowed = policy.allowedHosts.some((host) => hostMatches(candidate.host, host));
    if (!allowed) {
      return {
        allowed: false,
        reason: `Host "${candidate.raw}" is outside the execution policy allowed hosts`,
      };
    }
  }

  return { allowed: true, reason: "" };
}

/** Check one raw host or URL against an ExecutionPolicy host allow/deny list. */
export function isHostAllowedByPolicy(
  policy: ExecutionPolicy,
  hostOrUrl: string,
): boolean {
  const host = normalizeHost(hostOrUrl);
  if (host === null) return policy.allowedHosts.length === 0;

  const denied = policy.deniedHosts.some((deniedHost) => hostMatches(host, deniedHost));
  if (denied) return false;

  return policy.allowedHosts.length === 0
    || policy.allowedHosts.some((allowedHost) => hostMatches(host, allowedHost));
}

/** Scan credential-scope requests in tool arguments against an ExecutionPolicy. */
export function scanCredentials(policy: ExecutionPolicy, args: unknown): PolicyCheckResult {
  if (!isPolicyScopeValid(policy)) {
    return { allowed: false, reason: "Execution policy has missing or unknown credential scope" };
  }

  const requested = findCredentialAccess(args);
  if (requested === null) {
    return { allowed: true, reason: "" };
  }

  if (!isCredentialAccessAllowed(policy, requested)) {
    return {
      allowed: false,
      reason: `Credential access '${requested}' exceeds execution policy scope '${policy.credentialScope}'`,
    };
  }

  return { allowed: true, reason: "" };
}

/** Scan a tool name against ExecutionPolicy tool allow/deny lists. */
export function scanToolName(policy: ExecutionPolicy, toolName: string): PolicyCheckResult {
  if (policy.deniedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is explicitly denied by execution policy`,
    };
  }

  if (policy.allowedTools.length > 0 && !policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the execution policy allowlist`,
    };
  }

  return { allowed: true, reason: "" };
}

function collectCandidatePaths(rootPath: string, args: unknown): CandidatePath[] {
  if (!isRecord(args)) return [];

  const candidates: CandidatePath[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && shouldTreatAsPath(key, value)) {
      candidates.push({ raw: value, resolved: resolvePolicyPath(rootPath, value) });
    }
  }
  return candidates;
}

function collectHostCandidates(args: unknown): HostCandidate[] {
  if (!isRecord(args)) return [];

  const candidates: HostCandidate[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !shouldTreatAsHost(key, value)) continue;
    const host = normalizeHost(value);
    if (host !== null) candidates.push({ raw: value, host });
  }
  return candidates;
}

function isPolicyScopeValid(policy: ExecutionPolicy): boolean {
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

function shouldTreatAsPath(key: string, value: string): boolean {
  return PATH_KEYS.has(key) || key.endsWith("Path") || isPathLike(value);
}

function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function shouldTreatAsHost(key: string, value: string): boolean {
  return HOST_KEYS.has(key) || key.endsWith("Url") || key.endsWith("Host") || isUrlLike(value);
}

function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("ws://") || value.startsWith("wss://");
}

function hostMatches(host: string, pattern: string): boolean {
  const normalized = normalizeHost(pattern);
  if (normalized === null) return false;
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(2);
    return host.endsWith(`.${suffix}`);
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

function normalizeHost(hostOrUrl: string): string | null {
  const raw = hostOrUrl.trim();
  if (raw.length === 0) return null;

  try {
    const url = isUrlLike(raw) ? new URL(raw) : new URL(`http://${raw}`);
    return cleanHostname(url.hostname);
  } catch {
    return cleanHostname(raw);
  }
}

function cleanHostname(hostname: string): string | null {
  const unbracketed = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase().replace(/\.$/, "");
  const colonCount = (unbracketed.match(/:/g) ?? []).length;
  const withoutPort = colonCount === 1 ? unbracketed.split(":")[0] ?? "" : unbracketed;
  const cleaned = isLoopbackHost(withoutPort) ? "localhost" : withoutPort;
  return cleaned.length > 0 ? cleaned : null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "::1"
    || hostname === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
