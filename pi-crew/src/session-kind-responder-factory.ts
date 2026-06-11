/**
 * Session-kind-aware responder factory routing for the pi-crew composition root.
 *
 * Routes responder creation based on `kind` in the factory context:
 * - Worker sessions get a lightweight responder (they don't use instance-level
 *   message processing — execution goes through AgentWorkerExecutor).
 * - Conversational and delegated sessions get the full conversational runtime
 *   factory (LLM agent, tools, profile assembly).
 *
 * DESIGN: Worker sessions must not require a conversational agent match.
 * Rationale: WorkerRuntime drives execution through AgentWorkerExecutor, not
 * through the instance's processMessage path. The instance responder is only
 * used for session lifecycle bookkeeping; worker sessions don't send chat
 * messages through the responder.
 *
 * @module pi-crew/session-kind-responder-factory
 */

import type { AgentResponder, AgentResponderFactory, AgentResponderFactoryContext } from "@pi-crew/service";
import { EchoAgentResponder } from "@pi-crew/service";

/**
 * Routes responder creation by session kind.
 *
 * Delegates to the conversational factory for non-worker sessions.
 * Returns an echo responder for worker sessions (no conversational match needed).
 */
export class SessionKindAwareResponderFactory implements AgentResponderFactory {
  constructor(
    private readonly conversationalFactory: AgentResponderFactory,
  ) {}

  createResponder(context: AgentResponderFactoryContext): AgentResponder {
    if (context.kind === "worker") {
      // DESIGN: Worker sessions bypass conversational agent assembly entirely.
      // Rationale: WorkerRuntime execution goes through AgentWorkerExecutor,
      // not through the instance's processMessage/responder path. The instance
      // is created for session bookkeeping (1:1 session-instance invariant)
      // but the responder is never meaningfully invoked for worker sessions.
      return new EchoAgentResponder();
    }

    return this.conversationalFactory.createResponder(context);
  }
}
