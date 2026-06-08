/**
 * SteerFollowUpBridge — routes Den Channels direct-agent events with
 * steer/followUp intent metadata to the correct active supervised
 * Agent via the {@link AgentRuntimeRegistry}.
 *
 * Installed in the composition root (crew.ts) as a pre-filter on the
 * channel message handler before {@code SessionManager.routeMessage}.
 *
 * @module pi-crew/steer-followup-bridge
 */

import type { ChannelContent, ChannelMessage, Logger } from "@pi-crew/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeRegistry, AgentRuntimeEntry } from "@pi-crew/service";

/**
 * Recognized intent values that trigger steer/followUp routing.
 */
const STEER_INTENT = "steer";
const FOLLOW_UP_INTENT = "follow_up";

/**
 * Bridges mid-assignment interaction from Den Channels direct-agent
 * events into the active Agent's steering/follow-up queues.
 *
 * ## Usage
 *
 * ```ts
 * const bridge = new SteerFollowUpBridge(registry, logger);
 * channelProvider.onMessage((message) => {
 *   if (bridge.route(message)) return;
 *   return sessionManager.routeMessage(channelProvider, message);
 * });
 * ```
 */
export class SteerFollowUpBridge {
  readonly #registry: AgentRuntimeRegistry;
  readonly #logger: Logger;

  constructor(registry: AgentRuntimeRegistry, logger: Logger) {
    this.#registry = registry;
    this.#logger = logger;
  }

  /**
   * Attempt to route a channel message to an active supervised Agent.
   *
   * @returns `true` if the message was handled (steer/followUp routed
   *   or intentionally discarded with a warning). `false` if the message
   *   should fall through to normal session routing.
   */
  route(message: ChannelMessage): boolean {
    const metadata = message.metadata;
    if (metadata === undefined) return false;
    if (typeof metadata !== "object") return false;

    const record: Record<string, unknown> = metadata;
    const intent = record.intent;

    if (intent !== STEER_INTENT && intent !== FOLLOW_UP_INTENT) {
      return false;
    }

    // Resolve the target agent
    const workerRunId = typeof record.workerRunId === "string" ? record.workerRunId : undefined;
    const assignmentId = typeof record.assignmentId === "string" ? record.assignmentId : undefined;

    const entry = this.#resolveEntry(workerRunId, assignmentId);
    if (entry === undefined) {
      this.#logger.warn("SteerFollowUpBridge: no active Agent for steer/followUp", {
        intent: intent,
        workerRunId: workerRunId ?? "N/A",
        assignmentId: assignmentId ?? "N/A",
      });
      return true;
    }

    if (!entry.supervisor.isActive) {
      this.#logger.warn("SteerFollowUpBridge: Agent is no longer active", {
        intent: intent,
        workerRunId: workerRunId ?? "N/A",
        assignmentId: assignmentId ?? "N/A",
      });
      return true;
    }

    const agentMessage = this.#buildAgentMessage(message.content);

    // Route to the correct queue
    if (intent === STEER_INTENT) {
      entry.agent.steer(agentMessage);
      this.#logger.info("SteerFollowUpBridge: steered Agent", {
        workerRunId: workerRunId ?? "N/A",
        assignmentId: assignmentId ?? "N/A",
      });
    } else {
      entry.agent.followUp(agentMessage);
      this.#logger.info("SteerFollowUpBridge: followUp queued for Agent", {
        workerRunId: workerRunId ?? "N/A",
        assignmentId: assignmentId ?? "N/A",
      });
    }

    return true;
  }

  // ── Internals ─────────────────────────────────────────────────

  #resolveEntry(
    workerRunId: string | undefined,
    assignmentId: string | undefined,
  ): AgentRuntimeEntry | undefined {
    // Primary: lookup by workerRunId
    if (workerRunId !== undefined) {
      const entry = this.#registry.findByRunId(workerRunId);
      if (entry !== undefined) return entry;
    }

    // Secondary: lookup by assignmentId
    if (assignmentId !== undefined) {
      return this.#registry.findByAssignmentId(assignmentId);
    }

    this.#logger.warn(
      "SteerFollowUpBridge: steer/followUp event missing runId or assignmentId",
    );

    return undefined;
  }

  /**
   * Build a minimal AgentMessage from plain text.
   *
   * Uses the pi-agent-core UserMessage shape:
   * `{ role: "user", content: string, timestamp: number }`.
   */
  #buildAgentMessage(content: ChannelContent): AgentMessage {
    return {
      role: "user",
      content: channelContentToText(content),
      timestamp: Date.now(),
    };
  }
}

function channelContentToText(content: ChannelContent): string {
  switch (content.kind) {
    case "text":
      return content.text;
    case "media":
      return content.altText ?? content.url;
    case "mixed":
      return content.parts.map(channelContentToText).join("\n");
  }
}
