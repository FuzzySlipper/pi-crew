/**
 * post_structured_completion tool — workers submit machine-checkable
 * completion packets to Den Core.
 *
 * This is the canonical handoff path for worker completions. Prose
 * responses and exit codes are not sufficient — every worker must
 * post a structured packet.
 *
 * @module pi-tools/post-structured-completion
 */

import type {
  CompletionPacket,
  CompletionPostResult,
  CompletionStatus,
  EventBus,
  Logger,
} from "@pi-crew/core";

// ── Packet validator ──────────────────────────────────────────

/**
 * Errors found during packet validation.
 */
export interface ValidationErrors {
  readonly missing: string[];
  readonly invalid: string[];
}

/**
 * Validate that a {@link CompletionPacket} has all required fields.
 *
 * @returns A {@link ValidationErrors} object with lists of missing
 *   and invalid fields. If both lists are empty, the packet is valid.
 */
export function validateCompletionPacket(
  packet: CompletionPacket,
): ValidationErrors {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!packet.assignmentId || packet.assignmentId.length === 0) {
    missing.push("assignmentId");
  }
  if (!packet.runId || packet.runId.length === 0) {
    missing.push("runId");
  }
  if (!packet.taskId || packet.taskId.length === 0) {
    missing.push("taskId");
  }
  const packetStatus: string = packet.status;
  if (!["completed", "failed", "blocked", "exhausted"].includes(packetStatus)) {
    invalid.push(`status: "${packetStatus}" is not a valid CompletionStatus`);
  }
  if (!packet.role || packet.role.length === 0) {
    missing.push("role");
  }
  if (packet.artifacts.length === 0) {
    missing.push("artifacts (at least one artifact required)");
  }

  // If blocked, blocker is required
  if (packet.status === "blocked" && !packet.blocker) {
    missing.push("blocker (required when status is 'blocked')");
  }

  return { missing, invalid };
}

// ── Completion poster ────────────────────────────────────────

/**
 * Callback invoked to post a completion packet to Den Core.
 *
 * The actual HTTP/MCP transport is handled externally; this
 * interface defines the contract.
 */
export type CompletionPoster = (
  packet: CompletionPacket,
) => Promise<CompletionPostResult>;

/**
 * Post a structured completion packet via the configured poster,
 * emitting governance events and returning the result.
 *
 * @param packet — The completion packet to post.
 * @param poster — The transport callback (HTTP/MCP to Den).
 * @param eventBus — Event bus for emitting `completion.posted`.
 * @param logger — Optional logger.
 * @returns The {@link CompletionPostResult} from Den.
 * @throws If packet validation fails or the poster throws.
 */
export async function postStructuredCompletion(
  packet: CompletionPacket,
  poster: CompletionPoster,
  eventBus: EventBus,
  logger?: Logger,
): Promise<CompletionPostResult> {
  // Validate
  const errors = validateCompletionPacket(packet);
  if (errors.missing.length > 0 || errors.invalid.length > 0) {
    const msg = `Invalid completion packet: missing=[${errors.missing.join(", ")}] invalid=[${errors.invalid.join(", ")}]`;
    logger?.error("postStructuredCompletion: validation failed", {
      missing: errors.missing,
      invalid: errors.invalid,
      assignmentId: packet.assignmentId,
    });
    throw new Error(msg);
  }

  logger?.info("postStructuredCompletion: posting", {
    assignmentId: packet.assignmentId,
    status: packet.status,
    artifacts: packet.artifacts.length,
  });

  let result: CompletionPostResult;
  try {
    result = await poster(packet);
  } catch (err: unknown) {
    logger?.error("postStructuredCompletion: poster threw", {
      error: String(err),
      assignmentId: packet.assignmentId,
    });
    throw err;
  }

  // Emit governance event
  eventBus.emit({
    event: "completion.posted",
    payload: {
      assignmentId: packet.assignmentId,
      runId: packet.runId,
      taskId: packet.taskId,
      status: packet.status,
      accepted: result.accepted,
    },
  });

  return result;
}

// ── Packet builder ───────────────────────────────────────────

/**
 * Input for building a {@link CompletionPacket}.
 */
export interface CompletionPacketInput {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly status: CompletionStatus;
  readonly role: string;
  readonly artifacts: {
    readonly type: string;
    readonly ref: string;
    readonly summary: string;
  }[];
  readonly filesTouched?: string[];
  readonly toolsUsed?: string[];
  readonly tokensConsumed?: number;
  readonly durationMs?: number;
  readonly turnCount?: number;
  readonly blocker?: {
    readonly reason: string;
    readonly requires: "human" | "dependency" | "review";
    readonly details: string;
  };
}

/**
 * Build a {@link CompletionPacket} from sparse input, filling in
 * defaults and recording the current timestamp.
 */
export function buildCompletionPacket(
  input: CompletionPacketInput,
): CompletionPacket {
  return {
    assignmentId: input.assignmentId,
    runId: input.runId,
    taskId: input.taskId,
    status: input.status,
    artifacts: input.artifacts,
    filesTouched: input.filesTouched ?? [],
    toolsUsed: input.toolsUsed ?? [],
    tokensConsumed: input.tokensConsumed ?? 0,
    durationMs: input.durationMs ?? 0,
    turnCount: input.turnCount ?? 0,
    blocker: input.blocker,
    role: input.role,
    completedAt: new Date().toISOString(),
  };
}
