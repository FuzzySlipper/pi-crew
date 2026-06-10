/**
 * AgentResponder — injectable runtime response boundary.
 *
 * Keeps agent-instance lifecycle separate from provider/tool response
 * generation so follow-up tasks can swap echo for real runtimes without
 * changing session or pool ownership.
 *
 * @module pi-service/instances/agent-responder
 */

import type { ChannelContent, ChannelMessage, EffectiveDelegationRuntime } from "@pi-crew/core";

/** Input passed from an agent instance to its response runtime. */
export interface AgentResponseRequest {
  readonly sessionId: string;
  readonly profileId: string;
  readonly instanceId: string;
  readonly message: ChannelMessage;
}

/** Produces a channel response for an inbound agent message. */
export interface AgentResponder {
  respond(request: AgentResponseRequest): Promise<ChannelContent>;
}

/** Context used to create a responder for one fresh agent instance. */
export interface AgentResponderFactoryContext {
  readonly profileId: string;
  readonly role?: string;
  /** Session-local runtime selection; does not mutate the source profile. */
  readonly effectiveRuntime?: EffectiveDelegationRuntime;
}

/** Creates responder instances for freshly-created agent instances. */
export interface AgentResponderFactory {
  createResponder(context: AgentResponderFactoryContext): AgentResponder;
}

/** Echo responder preserving the current spike behavior exactly. */
export class EchoAgentResponder implements AgentResponder {
  respond(request: AgentResponseRequest): Promise<ChannelContent> {
    const text =
      request.message.content.kind === "text" ? request.message.content.text : "[non-text content]";

    return Promise.resolve({ kind: "text", text: `received: ${text}` });
  }
}

/** Default responder factory for echo-compatible runtime behavior. */
export class EchoAgentResponderFactory implements AgentResponderFactory {
  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    void context;
    return new EchoAgentResponder();
  }
}
