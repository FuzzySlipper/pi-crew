import type { WorkerPolicy } from "@pi-crew/core";

export interface HostPolicyResult {
  readonly allowed: boolean;
  readonly reason: string;
}

interface HostCandidate {
  readonly raw: string;
  readonly host: string;
}

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

export function checkNetworkHostPolicy(
  policy: WorkerPolicy,
  args: unknown,
): HostPolicyResult {
  for (const candidate of collectHostCandidates(args)) {
    const denied = policy.deniedHosts.find((host) => hostMatches(candidate.host, host));
    if (denied !== undefined) {
      return {
        allowed: false,
        reason: `Host "${candidate.raw}" is denied by worker policy (${denied})`,
      };
    }

    if (policy.allowedHosts.length === 0) continue;

    const allowed = policy.allowedHosts.some((host) => hostMatches(candidate.host, host));
    if (!allowed) {
      return {
        allowed: false,
        reason: `Host "${candidate.raw}" is outside the worker policy allowed hosts`,
      };
    }
  }

  return { allowed: true, reason: "" };
}

export function isHostAllowedByPolicy(
  policy: WorkerPolicy,
  hostOrUrl: string,
): boolean {
  const host = normalizeHost(hostOrUrl);
  if (host === null) return policy.allowedHosts.length === 0;

  const denied = policy.deniedHosts.some((deniedHost) => hostMatches(host, deniedHost));
  if (denied) return false;

  return policy.allowedHosts.length === 0
    || policy.allowedHosts.some((allowedHost) => hostMatches(host, allowedHost));
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
