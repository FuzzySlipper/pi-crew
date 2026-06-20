/**
 * ChannelRouter — binding map, mention matching, and channel authorization
 * for all channel providers (Den Channels, Telegram, etc.).
 *
 * Sits between `provider.onMessage()` and `sessionManager.routeMessage()`.
 * Each provider's message handler calls `router.route(provider, message)`,
 * and only passes the returned (possibly rewritten) message to the session
 * manager.  If the router returns `null`, the caller drops the message.
 *
 * @module pi-crew/channel-router
 */

import type { Logger } from "@pi-crew/core";
import type { ChannelMessage } from "@pi-crew/core";
import { routeMentionedAgent } from "./mention-router.js";

// ── Types ────────────────────────────────────────────────────────

/**
 * Agent identity shape needed for building the binding map and mention
 * matching.
 */
export interface ChannelRouterAgentBinding {
  /** The agent's member identity. */
  readonly memberIdentity: string;
  /** The channel IDs this agent is authorized to receive messages from. */
  readonly channelIds: readonly string[];
}

/**
 * Configuration for the ChannelRouter.
 */
export interface ChannelRouterConfig {
  /**
   * Agent bindings derived from the full-agents config.  Each entry lists
   * the channel IDs that agent is authorized to receive messages from.
   */
  readonly agentBindings: readonly ChannelRouterAgentBinding[];
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Build the reverse map: channelId → agent memberIdentities.
 */
function buildChannelToAgents(
  bindings: readonly ChannelRouterAgentBinding[],
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const binding of bindings) {
    for (const channelId of binding.channelIds) {
      let agents = map.get(channelId);
      if (agents === undefined) {
        agents = [];
        map.set(channelId, agents);
      }
      agents.push(binding.memberIdentity);
    }
  }
  return map;
}

// ── Router ───────────────────────────────────────────────────────

export class ChannelRouter {
  readonly #channelToAgents: ReadonlyMap<string, readonly string[]>;
  readonly #mentionAgents: ReadonlyArray<{ readonly memberIdentity: string }>;
  readonly #logger: Logger;

  constructor(config: ChannelRouterConfig, logger: Logger) {
    this.#channelToAgents = buildChannelToAgents(config.agentBindings);
    this.#mentionAgents = config.agentBindings.map((b) => ({
      memberIdentity: b.memberIdentity,
    }));
    this.#logger = logger;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Route a message through the ChannelRouter.
   *
   * 1. **Channel authorization** — if no agent is bound to the message's
   *    channel, drop the message (return `null`).
   * 2. **Mention matching** — scan the message body for @mentions of
   *    configured agents and rewrite metadata so the session router can
   *    deliver to the correct agent.
   *
   * @param providerName The provider that delivered the message (for logging).
   * @param message  The inbound channel message.
   * @returns The (possibly rewritten) message, or `null` if the message
   *          should be dropped.
   */
  route(
    providerName: string,
    message: ChannelMessage,
  ): ChannelMessage | null {
    // 1. Channel authorization
    const channelId = message.channelId;
    const authorizedAgents = this.#channelToAgents.get(channelId);

    if (authorizedAgents === undefined || authorizedAgents.length === 0) {
      this.#logger.debug("ChannelRouter dropping message from unauthorized channel", {
        provider: providerName,
        channelId,
        messageId: message.id,
      });
      return null;
    }

    // 2. Mention matching
    const routed = routeMentionedAgent(message, this.#mentionAgents);

    return routed;
  }

  /**
   * Check whether a channel has any agents bound to it.
   * Used by the composition root for startup validation.
   */
  hasChannel(channelId: string): boolean {
    return this.#channelToAgents.has(channelId);
  }

  /**
   * Return the agents bound to a channel (for diagnostics).
   * Returns an empty array if none.
   */
  agentsForChannel(channelId: string): readonly string[] {
    return this.#channelToAgents.get(channelId) ?? [];
  }
}
