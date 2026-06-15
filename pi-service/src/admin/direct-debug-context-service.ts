/** Bounded debug context projector for service-backed full-agent sessions. */
import type { MessageRepository } from "../persistence/types.js";
import type { DiagnosticsProjector } from "./admin-server.js";
import type { DirectDebugSessionContextView } from "./direct-debug-types.js";

export interface DirectDebugContextServiceDeps {
  readonly diagnostics: DiagnosticsProjector;
  readonly messages: MessageRepository;
}

export class DirectDebugContextService {
  readonly #diagnostics: DiagnosticsProjector;
  readonly #messages: MessageRepository;

  constructor(deps: DirectDebugContextServiceDeps) {
    this.#diagnostics = deps.diagnostics;
    this.#messages = deps.messages;
  }

  async projectContext(sessionId: string, limit: number): Promise<DirectDebugSessionContextView> {
    const overview = await this.#diagnostics.projectOverview();
    const session = overview.sessions.find((candidate) => candidate.sessionId === sessionId);
    const boundedLimit = Math.max(1, Math.min(limit, 200));
    const [messages, messageCount] = await Promise.all([
      this.#messages.getRecentBySession(sessionId, boundedLimit),
      this.#messages.count(sessionId),
    ]);
    return {
      sessionId,
      limit: boundedLimit,
      messageCount,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        toolName: message.tool_name,
        tokenCount: message.token_count,
        createdAt: message.created_at,
      })),
      contextPressure: session?.contextPressure ?? null,
      contextCompaction: session?.contextCompaction ?? null,
    };
  }
}
