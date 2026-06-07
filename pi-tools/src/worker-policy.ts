/**
 * WorkerPolicy factory and validation.
 *
 * Creates bounded `WorkerPolicy` objects from Den-style assignment data
 * with sensible defaults. The policy is enforced by the runtime, not by
 * agent judgment.
 *
 * @module pi-tools/worker-policy
 */

import path from "node:path";
import type { WorkerPolicy } from "@pi-crew/core";

// ── Defaults ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS_PER_TURN = 128_000;

// ── Policy input ──────────────────────────────────────────────

/**
 * Partial policy input used to construct a full {@link WorkerPolicy}.
 *
 * All fields are optional — sensible defaults are applied by
 * {@link createWorkerPolicy}.
 */
export interface WorkerPolicyInput {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly role: string;

  // Filesystem
  readonly workdir?: string;
  readonly allowedPaths?: string[];
  readonly denyPaths?: string[];

  // Tools
  readonly allowedTools?: string[];
  readonly deniedTools?: string[];

  // Network
  readonly allowedHosts?: string[];
  readonly deniedHosts?: string[];

  // Time
  readonly maxDurationMs?: number;
  readonly maxTurnDurationMs?: number;
  readonly idleTimeoutMs?: number;

  // Budget
  readonly maxIterations?: number;
  readonly maxTokensPerTurn?: number;

  // Credentials
  readonly credentialScope?: "none" | "read_only" | "bounded_write" | "full";

  // Eviction
  readonly releaseOnCompletion?: boolean;
  readonly cleanupWorkdir?: boolean;
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a fully-populated {@link WorkerPolicy} from partial input,
 * applying sensible defaults for missing fields.
 */
export function createWorkerPolicy(input: WorkerPolicyInput): WorkerPolicy {
  return {
    assignmentId: input.assignmentId,
    role: input.role,
    workdir: input.workdir ?? "/tmp/pi-worker",
    allowedPaths: input.allowedPaths ?? [],
    denyPaths: input.denyPaths ?? [],
    allowedTools: input.allowedTools ?? [],
    deniedTools: input.deniedTools ?? [],
    allowedHosts: input.allowedHosts ?? [],
    deniedHosts: input.deniedHosts ?? [],
    maxDurationMs: input.maxDurationMs ?? DEFAULT_TIMEOUT_MS,
    maxTurnDurationMs: input.maxTurnDurationMs ?? DEFAULT_TURN_TIMEOUT_MS,
    idleTimeoutMs: input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    maxTokensPerTurn: input.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN,
    credentialScope: input.credentialScope ?? "none",
    releaseOnCompletion: input.releaseOnCompletion ?? true,
    cleanupWorkdir: input.cleanupWorkdir ?? true,
  };
}

// ── Path check ────────────────────────────────────────────────

/**
 * Check whether a path is allowed under the given policy.
 *
 * @returns `true` if the path is allowed, `false` if denied.
 */
export function isPathAllowed(
  policy: WorkerPolicy,
  targetPath: string,
): boolean {
  const resolved = resolvePolicyPath(policy.workdir, targetPath);

  for (const deny of policy.denyPaths) {
    if (isWithinOrEqual(resolved, resolvePolicyPath(policy.workdir, deny))) {
      return false;
    }
  }

  const allowedRoots = policy.allowedPaths.length > 0
    ? policy.allowedPaths
    : [policy.workdir];
  return allowedRoots.some((allowed: string) =>
    isWithinOrEqual(resolved, resolvePolicyPath(policy.workdir, allowed)),
  );
}

function resolvePolicyPath(workdir: string, inputPath: string): string {
  const base = path.resolve(workdir);
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(base, inputPath);
  return trimTrailingSeparator(resolved);
}

function isWithinOrEqual(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function trimTrailingSeparator(inputPath: string): string {
  const normalized = path.normalize(inputPath);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

// ── Host check ────────────────────────────────────────────────

/**
 * Check whether a host is allowed under the given policy.
 *
 * @returns `true` if the host is allowed, `false` if denied.
 */
export function isHostAllowed(policy: WorkerPolicy, host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === null) {
    return policy.allowedHosts.length === 0;
  }

  for (const denied of policy.deniedHosts) {
    if (hostMatches(normalized, denied)) {
      return false;
    }
  }

  if (policy.allowedHosts.length > 0) {
    return policy.allowedHosts.some((allowed: string) =>
      hostMatches(normalized, allowed),
    );
  }

  return true;
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

function isUrlLike(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("ws://") || value.startsWith("wss://");
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

// ── Iteration check ───────────────────────────────────────────

/**
 * Check whether a given iteration count has exceeded the policy budget.
 *
 * @returns `true` if budget is exhausted.
 */
export function isIterationBudgetExhausted(
  policy: WorkerPolicy,
  currentIteration: number,
): boolean {
  return currentIteration >= policy.maxIterations;
}

/**
 * Check whether iteration budget is nearly exhausted (within 80%
 * of the max), suggesting drain mode should activate.
 */
export function isIterationBudgetLow(
  policy: WorkerPolicy,
  currentIteration: number,
): boolean {
  return currentIteration >= policy.maxIterations * 0.8;
}
