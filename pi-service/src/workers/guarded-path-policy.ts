import path from "node:path";
import type { WorkerPolicy } from "@pi-crew/core";

export interface PathPolicyResult {
  readonly allowed: boolean;
  readonly reason: string;
}

interface CandidatePath {
  readonly raw: string;
  readonly resolved: string;
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

export function checkFilesystemPathPolicy(
  policy: WorkerPolicy,
  args: unknown,
): PathPolicyResult {
  for (const candidate of collectCandidatePaths(policy.workdir, args)) {
    const denyRoot = policy.denyPaths.find((deny) =>
      isWithinOrEqual(candidate.resolved, resolvePolicyPath(policy.workdir, deny)),
    );
    if (denyRoot !== undefined) {
      return {
        allowed: false,
        reason: `Path "${candidate.raw}" is denied by worker policy (${denyRoot})`,
      };
    }

    const allowedRoots = policy.allowedPaths.length > 0
      ? policy.allowedPaths
      : [policy.workdir];
    const allowed = allowedRoots.some((allowedPath) =>
      isWithinOrEqual(candidate.resolved, resolvePolicyPath(policy.workdir, allowedPath)),
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: `Path "${candidate.raw}" is outside the worker policy allowed paths`,
      };
    }
  }

  return { allowed: true, reason: "" };
}

function collectCandidatePaths(workdir: string, args: unknown): CandidatePath[] {
  if (!isRecord(args)) return [];

  const candidates: CandidatePath[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && shouldTreatAsPath(key, value)) {
      candidates.push({ raw: value, resolved: resolvePolicyPath(workdir, value) });
    }
  }
  return candidates;
}

function shouldTreatAsPath(key: string, value: string): boolean {
  return PATH_KEYS.has(key) || key.endsWith("Path") || isPathLike(value);
}

function isPathLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
