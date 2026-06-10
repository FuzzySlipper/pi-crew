interface TurnQueueEntry<T> {
  readonly promise: Promise<T>;
}

export interface ConversationalTurnCoordinatorOptions {
  readonly turnTimeoutMs?: number;
}

export const DEFAULT_CONVERSATIONAL_TURN_TIMEOUT_MS = 300_000;

/**
 * Serializes conversational turns per durable session ID.
 */
export class ConversationalTurnCoordinator {
  readonly turnTimeoutMs: number;
  private readonly queues = new Map<string, TurnQueueEntry<unknown>>();

  constructor(options: ConversationalTurnCoordinatorOptions = {}) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_CONVERSATIONAL_TURN_TIMEOUT_MS;
  }

  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId)?.promise ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(task);
    this.queues.set(sessionId, { promise: queued });
    return queued.finally(() => {
      if (this.queues.get(sessionId)?.promise === queued) {
        this.queues.delete(sessionId);
      }
    });
  }
}

export class ConversationalTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Conversational turn exceeded ${String(timeoutMs)}ms timeout`);
    this.name = "ConversationalTurnTimeoutError";
  }
}

export function withTurnTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ConversationalTurnTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export function isConversationalTurnTimeoutError(
  error: unknown,
): error is ConversationalTurnTimeoutError {
  return error instanceof ConversationalTurnTimeoutError;
}
