import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "@pi-crew/core";
import type { DelegationProjectionMessage } from "./den-delegation-channel-projection.js";

export class DelegationProjectionFileWriteError extends Error {
  readonly code = "DELEGATION_PROJECTION_FILE_WRITE_FAILED";

  constructor(path: string, cause: unknown) {
    super(`Delegation projection file append failed for ${path}`, { cause });
    this.name = "DelegationProjectionFileWriteError";
  }
}

export function appendDelegationProjectionToFile(input: {
  readonly enabled?: boolean;
  readonly path?: string;
  readonly logger: Logger;
  readonly message: DelegationProjectionMessage;
  readonly now?: Date;
}): void {
  if (input.enabled !== true || input.path === undefined || input.path.length === 0) return;
  try {
    mkdirSync(dirname(input.path), { recursive: true });
    appendFileSync(
      input.path,
      `${renderLogLine(input.message, input.now ?? new Date())}\n`,
      "utf8",
    );
  } catch (cause: unknown) {
    const error = new DelegationProjectionFileWriteError(input.path, cause);
    input.logger.warn("delegation.projection.file_failed", {
      code: error.code,
      eventName: input.message.eventName,
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function renderLogLine(message: DelegationProjectionMessage, now: Date): string {
  const details = pickUsefulDetails(message.details);
  return JSON.stringify({
    timestamp: now.toISOString(),
    eventName: message.eventName,
    summary: message.summary.slice(0, 500),
    ...details,
  });
}

function pickUsefulDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of usefulDetailKeys) {
    const value = details[key];
    if (value === undefined || value === null || value === "") continue;
    picked[key] = boundValue(value);
  }
  return picked;
}

function boundValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value).slice(0, 500);
}

const usefulDetailKeys = [
  "childSessionId",
  "parentSessionId",
  "rootSessionId",
  "profileId",
  "provider",
  "model",
  "policyId",
  "depth",
  "phase",
  "turnNumber",
  "toolName",
  "toolCallId",
  "durationMs",
  "outcome",
  "turnsUsed",
  "tokensConsumed",
  "evidenceChecked",
  "artifactCount",
  "failureCategory",
  "structureRepair",
  "reason",
  "error",
  "recoveryGuidance",
  "task",
];
