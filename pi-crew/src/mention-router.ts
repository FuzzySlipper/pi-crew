/**
 * Mention-aware pre-routing for Den Channels messages.
 *
 * When a channel message contains an {@literal @}mention of a configured full agent
 * (e.g. {@literal @}prime-coder), this module rewrites the message metadata so the
 * session router can find and route to that agent's configured session.
 *
 * Without this step, general channel messages lack {@code memberIdentity} in
 * metadata, and {@code findConfiguredFullSession} (in pi-service) cannot match
 * them to any configured binding — the message falls through to an unbound
 * fallback session instead of reaching the targeted agent.
 *
 * @module pi-crew/mention-router
 */

import type { ChannelMessage } from "@pi-crew/core";

// ── Types ───────────────────────────────────────────────────────

/**
 * Minimal agent config needed for mention matching.
 */
export interface MentionRouterAgent {
  /** The agent's memberIdentity (used to match {@literal @}mentions). */
  readonly memberIdentity: string;
}

// ── Mention regex ───────────────────────────────────────────────

/**
 * Match {@literal @}memberIdentity patterns in message text.
 *
 * Requires the mention to start at a word boundary (after whitespace, start of
 * string, or punctuation) and captures word-chars plus hyphens — handling
 * agent identities like {@literal @}prime-coder or {@literal @}pi-crew-runner-clone.
 *
 * Not preceded by word-char so we don't match email usernames mid-address.
 */
const MENTION_PATTERN = /(?<=^|\s|[^\w])@(\w[\w-]*\w|\w)/g;

// ── Router ──────────────────────────────────────────────────────

/**
 * Parse the message body for {@literal @}memberIdentity mentions of configured
 * full agents and rewrite the message metadata so the session router can
 * deliver it to the correct agent.
 *
 * **Rules:**
 * - Only processes {@code kind: "text"} messages. {@code "media"} and
 *   {@code "mixed"} messages pass through unchanged.
 * - Scans all {@literal @}mentions. Uses the **first** match against a configured
 *   agent's memberIdentity.
 * - If a match is found, returns a new {@link ChannelMessage} with
 *   {@code metadata.memberIdentity} set to the matched agent's identity.
 * - If no match or no {@literal @}mentions, returns the original message unchanged.
 *
 * @param message The inbound channel message.
 * @param agents  The list of configured full agents to match against.
 * @returns The original or rewritten message.
 */
export function routeMentionedAgent(
  message: ChannelMessage,
  agents: readonly MentionRouterAgent[],
): ChannelMessage {
  // Only text messages can carry @mentions
  if (message.content.kind !== "text") return message;

  const text = message.content.text;

  // Quick check: skip if there's no '@' in the message at all
  if (!text.includes("@")) return message;

  const matches = text.matchAll(MENTION_PATTERN);

  for (const match of matches) {
    const mentioned = match[1];
    if (mentioned === undefined || mentioned.length === 0) continue;

    // Check if this mention matches any configured agent
    const agent = agents.find((a) => a.memberIdentity === mentioned);
    if (agent === undefined) continue;

    // Found a matching agent — rewrite metadata with the agent's memberIdentity
    return {
      ...message,
      metadata: {
        ...message.metadata,
        memberIdentity: agent.memberIdentity,
      },
    };
  }

  return message;
}
