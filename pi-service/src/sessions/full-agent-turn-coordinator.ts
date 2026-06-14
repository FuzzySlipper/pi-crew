interface TurnQueueEntry<T> {
  readonly promise: Promise<T>;
}

export interface FullAgentTurnCoordinatorOptions {
  readonly turnTimeoutMs?: number;
}

export const DEFAULT_CONVERSATIONAL_TURN_TIMEOUT_MS = 300_000;

/**
 * Serializes fullAgent turns per durable session ID.
 */
export class FullAgentTurnCoordinator {
  readonly turnTimeoutMs: number;
  private readonly queues = new Map<string, TurnQueueEntry<unknown>>();

  constructor(options: FullAgentTurnCoordinatorOptions = {}) {
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

export class FullAgentTurnTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`FullAgent turn exceeded ${String(timeoutMs)}ms timeout`);
    this.name = "FullAgentTurnTimeoutError";
  }
}

export function withTurnTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new FullAgentTurnTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

export function isFullAgentTurnTimeoutError(
  error: unknown,
): error is FullAgentTurnTimeoutError {
  return error instanceof FullAgentTurnTimeoutError;
}
