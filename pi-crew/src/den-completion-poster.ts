/**
 * DenCompletionPoster — a {@link CompletionPoster} that posts structured
 * completion packets to Den Core via the MCP client.
 *
 * This is the canonical path for worker completion packets to reach Den
 * instead of only emitting a local EventBus `completion.posted` event.
 *
 * @module pi-crew/den-completion-poster
 */

import type { CompletionPacket, CompletionPostResult, Logger } from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import type { MCPClient } from "@pi-crew/mcp";

// ── Factory config ──────────────────────────────────────────────

/** Configuration for {@link createDenCompletionPoster}. */
export interface DenCompletionPosterConfig {
  /** MCP client connected to Den Core. */
  readonly mcpClient: MCPClient;

  /** Project ID for the completion packet. */
  readonly projectId: string;

  /** Agent identity posting the completion. */
  readonly requestedBy: string;

  /** Optional logger for diagnostic output. */
  readonly logger?: Logger;

  readonly completionDefaults?: DenCompletionDefaults;
}

export interface DenCompletionDefaults {
  readonly branch?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly testsRun?: readonly string[];
}

// ── Retry config ────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5_000;

const PACKET_TYPE_BY_ROLE: Readonly<Record<string, string>> = {
  coder: "implementation_packet",
  reviewer: "review_findings_packet",
  validator: "validation_packet",
  drift_checker: "drift_check_packet",
  "packet-auditor": "packet_audit_packet",
  packet_auditor: "packet_audit_packet",
};

// ── Factory ─────────────────────────────────────────────────────

/**
 * Create a {@link CompletionPoster} that calls Den Core's
 * `post_worker_completion_packet` MCP tool.
 *
 * The returned poster maps {@link CompletionPacket} fields to MCP tool
 * parameters and handles transient Den-unavailable errors with retry.
 * It always returns a {@link CompletionPostResult} — it never throws.
 *
 * @param config — Configuration for the poster.
 * @returns A CompletionPoster ready for injection into WorkerRuntime.
 */
export function createDenCompletionPoster(config: DenCompletionPosterConfig): CompletionPoster {
  const { mcpClient, projectId, requestedBy, logger, completionDefaults } = config;

  return async (packet: CompletionPacket): Promise<CompletionPostResult> => {
    const params = buildCompletionParams(packet, projectId, requestedBy, completionDefaults);

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await mcpClient.callTool("post_worker_completion_packet", params);

        if (result.ok) {
          logger?.info("DenCompletionPoster: packet accepted by Den", {
            assignmentId: packet.assignmentId,
            runId: packet.runId,
            attempt,
          });
          return {
            accepted: true,
            message: extractMessage(result.content),
          };
        }

        // Den returned an error (tool call succeeded but result was not ok)
        lastError = result.error ?? "Den MCP tool returned non-ok result";
        logger?.warn("DenCompletionPoster: Den rejected packet", {
          assignmentId: packet.assignmentId,
          runId: packet.runId,
          error: lastError,
          attempt,
        });

        // Den rejection is not retryable — fail closed
        return {
          accepted: false,
          message: `Den rejected completion: ${lastError}`,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        logger?.warn("DenCompletionPoster: MCP call failed", {
          assignmentId: packet.assignmentId,
          runId: packet.runId,
          error: lastError,
          attempt,
        });

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    logger?.error("DenCompletionPoster: all retries exhausted", {
      assignmentId: packet.assignmentId,
      runId: packet.runId,
      lastError,
      maxRetries: MAX_RETRIES,
    });

    return {
      accepted: false,
      message: `Den unavailable after ${String(MAX_RETRIES + 1)} attempts: ${lastError ?? "unknown error"}`,
    };
  };
}

// ── Parameter mapping ──────────────────────────────────────────

/**
 * Map a {@link CompletionPacket} to the parameters expected by
 * Den Core's `post_worker_completion_packet` MCP tool.
 */
function buildCompletionParams(
  packet: CompletionPacket,
  projectId: string,
  requestedBy: string,
  defaults: DenCompletionDefaults | undefined,
): Record<string, unknown> {
  const summary = buildSummary(packet);

  const params: Record<string, unknown> = {
    project_id: projectId,
    run_id: packet.runId,
    requested_by: requestedBy,
    status: packet.status,
    role: packet.role,
    packet_type: resolvePacketType(packet.role),
    summary,
  };
  if (defaults?.branch !== undefined) params.branch = defaults.branch;
  if (defaults?.baseCommit !== undefined) params.base_commit = defaults.baseCommit;
  if (defaults?.headCommit !== undefined) params.head_commit = defaults.headCommit;
  if (defaults?.testsRun !== undefined) params.tests_run = JSON.stringify(defaults.testsRun);
  return params;
}

function resolvePacketType(role: string): string {
  return PACKET_TYPE_BY_ROLE[role] ?? "implementation_packet";
}

/**
 * Build a human-readable summary from a {@link CompletionPacket}.
 */
function buildSummary(packet: CompletionPacket): string {
  const parts: string[] = [];

  parts.push(`Assignment ${packet.assignmentId}: ${packet.status} by ${packet.role}`);

  if (packet.artifacts.length > 0) {
    const artifactDescs = packet.artifacts.map((a) => `${a.type}: ${a.summary}`);
    parts.push(`Artifacts: ${artifactDescs.join("; ")}`);
  }

  if (packet.filesTouched.length > 0) {
    parts.push(`Files: ${packet.filesTouched.join(", ")}`);
  }

  if (packet.toolsUsed.length > 0) {
    parts.push(`Tools: ${packet.toolsUsed.join(", ")}`);
  }

  if (packet.tokensConsumed > 0 || packet.durationMs > 0) {
    parts.push(
      `Tokens: ${String(packet.tokensConsumed)}, Duration: ${String(packet.durationMs)}ms, Turns: ${String(packet.turnCount)}`,
    );
  }

  if (packet.blocker) {
    parts.push(`Blocker: ${packet.blocker.reason} (requires: ${packet.blocker.requires})`);
  }

  return parts.join(" | ");
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Extract a message string from MCP tool call content blocks.
 */
function extractMessage(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
): string {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "Completion packet posted (no text response)";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}
