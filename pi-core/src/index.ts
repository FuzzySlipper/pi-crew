// pi-core — Foundation types, interfaces, and utilities.
// Zero internal dependencies. Everything else builds on this.

// ── Domain types ──────────────────────────────────────────────
export type GatewayEvent = {
  event: string;
  payload: unknown;
};

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

// ── Error hierarchy ───────────────────────────────────────────
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ── Logger interface ──────────────────────────────────────────
export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

// ── EventBus interface ────────────────────────────────────────
export interface EventBus {
  emit(event: GatewayEvent): void;
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

// ── ChannelProvider interface (canonical vocabulary) ──────────
export interface ChannelProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: string, content: string): Promise<void>;
}

// ── Repository interface ──────────────────────────────────────
export interface Repository<T> {
  getById(id: string): Promise<T | null>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

// ── Retry utilities ───────────────────────────────────────────
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === policy.maxAttempts) break;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
