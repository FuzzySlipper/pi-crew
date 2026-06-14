/** Conversational session reset boundary for /new. */
import type { EventBus } from "@pi-crew/core";
import type { InstancePool } from "../instances/instance-pool.js";
import type { MessageRepository } from "../persistence/types.js";
import type { SessionStore } from "../sessions/session-store.js";

export interface SessionResetRequest {
  readonly sessionId: string;
  readonly requestedBy: string;
  readonly reason: string;
}

export interface SessionResetResult {
  readonly oldSessionId: string;
  readonly newSessionId: string;
  readonly oldInstanceId: string | null;
  readonly newInstanceId: string | null;
  readonly archivedMessageCount: number;
  readonly resetAt: string;
}

export interface ConversationalSessionResetDeps {
  readonly sessionStore: SessionStore;
  readonly instancePool: InstancePool;
  readonly messageRepository?: MessageRepository;
  readonly eventBus: EventBus;
  readonly now?: () => string;
}

export class ConversationalSessionResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationalSessionResetError";
  }
}

export class ConversationalSessionResetService {
  readonly #sessionStore: SessionStore;
  readonly #instancePool: InstancePool;
  readonly #messageRepository?: MessageRepository;
  readonly #eventBus: EventBus;
  readonly #now: () => string;

  constructor(deps: ConversationalSessionResetDeps) {
    this.#sessionStore = deps.sessionStore;
    this.#instancePool = deps.instancePool;
    this.#messageRepository = deps.messageRepository;
    this.#eventBus = deps.eventBus;
    this.#now = deps.now ?? (() => new Date().toISOString());
  }

  async reset(request: SessionResetRequest): Promise<SessionResetResult> {
    const session = await this.#sessionStore.get(request.sessionId);
    if (session === null) throw new ConversationalSessionResetError("session_not_found");
    if (session.kind !== "conversational") {
      throw new ConversationalSessionResetError("worker_sessions_den_sovereign");
    }
    const archivedMessageCount = await this.#countAndClearMessages(session.id);
    if (session.instanceId !== null) await this.#instancePool.release(session.instanceId);
    const nextInstance = await this.#instancePool.acquire(
      session.profileId,
      session.workerBinding?.role,
      session.effectiveRuntime ?? undefined,
      session.id,
      session.kind,
    );
    const resetAt = this.#now();
    await this.#sessionStore.save({
      ...session,
      instanceId: nextInstance.id,
      state: "active",
      messageCount: 0,
      lastActiveAt: resetAt,
    });
    const result: SessionResetResult = {
      oldSessionId: session.id,
      newSessionId: session.id,
      oldInstanceId: session.instanceId,
      newInstanceId: nextInstance.id,
      archivedMessageCount,
      resetAt,
    };
    this.#eventBus.emit({
      event: "session.reset",
      payload: {
        sessionId: session.id,
        oldInstanceId: session.instanceId,
        newInstanceId: nextInstance.id,
        requestedBy: request.requestedBy,
        reason: request.reason,
        resetAt,
        archivedMessageCount,
      },
    });
    return result;
  }

  async #countAndClearMessages(sessionId: string): Promise<number> {
    if (this.#messageRepository === undefined) return 0;
    const count = await this.#messageRepository.count(sessionId);
    await this.#messageRepository.deleteBySession(sessionId);
    return count;
  }
}
