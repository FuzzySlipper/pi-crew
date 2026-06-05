/**
 * Error hierarchy for the pi-crew gateway.
 *
 * Every error carries `code`, `statusCode`, and `retryable` so callers
 * can make structured decisions without instanceof chains or string
 * matching on messages.
 *
 * @module pi-core/errors
 */

// ── GatewayError (abstract base) ────────────────────────────────

/**
 * Abstract base for all pi-crew errors.
 *
 * Concrete subclasses must set {@link code}, {@link statusCode}, and
 * {@link retryable}.  Never instantiate `GatewayError` directly.
 */
export abstract class GatewayError extends Error {
  /**
   * Stable machine-readable error code (e.g. `"CONFIGURATION_ERROR"`).
   */
  public abstract readonly code: string;

  /**
   * HTTP-equivalent status code for logging / gateway responses.
   */
  public abstract readonly statusCode: number;

  /**
   * Whether the operation may succeed on retry.
   */
  public abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

// ── Concrete errors ─────────────────────────────────────────────

/**
 * Invalid or missing configuration prevents the gateway from starting.
 * **Not retryable** — the operator must fix the config first.
 */
export class ConfigurationError extends GatewayError {
  public readonly code = "CONFIGURATION_ERROR";
  public readonly statusCode = 500;
  public readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * A transient network / transport failure.
 * **Retryable** — the caller should back off and retry.
 */
export class ConnectionError extends GatewayError {
  public readonly code = "CONNECTION_ERROR";
  public readonly statusCode = 502;
  public readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/**
 * The session pool is at capacity and cannot accept new sessions.
 * **Retryable** — sessions eventually expire and free capacity.
 */
export class SessionLimitError extends GatewayError {
  public readonly code = "SESSION_LIMIT_ERROR";
  public readonly statusCode = 429;
  public readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}

/**
 * An upstream AI provider returned an error (rate-limit, model
 * unavailable, billing, etc.).
 * **May be retryable** — depends on the specific provider response.
 */
export class ProviderError extends GatewayError {
  public readonly code = "PROVIDER_ERROR";
  public readonly statusCode = 502;
  public readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * An operation exceeded its deadline.
 * **Retryable** — the operation may succeed with more time.
 */
export class TimeoutError extends GatewayError {
  public readonly code = "TIMEOUT_ERROR";
  public readonly statusCode = 504;
  public readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Authentication with an external service failed.
 * **Not retryable** — credentials must be updated before retrying.
 */
export class AuthenticationError extends GatewayError {
  public readonly code = "AUTHENTICATION_ERROR";
  public readonly statusCode = 401;
  public readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}
