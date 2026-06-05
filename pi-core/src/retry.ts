/**
 * Retry utilities for transient-failure recovery.
 *
 * The `retryWithBackoff` helper is the only significant runtime
 * implementation in `pi-core` — everything else is pure types.
 *
 * @module pi-core/retry
 */

// ── RetryPolicy ─────────────────────────────────────────────────

/**
 * Configuration for exponential-backoff retry behaviour.
 */
export interface RetryPolicy {
  /** Maximum number of attempts (including the first call). */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry. */
  baseDelayMs: number;
  /** Ceiling on the computed delay. */
  maxDelayMs: number;
}

// ── Defaults ────────────────────────────────────────────────────

/**
 * A conservative default retry policy suitable for API calls.
 *
 * 5 attempts, starting at 200ms, capped at 30s.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 30_000,
};

// ── Helper ──────────────────────────────────────────────────────

/**
 * Execute an async function with exponential-backoff retry.
 *
 * On each failure, the delay doubles (`baseDelayMs * 2^(attempt-1)`)
 * capped at `maxDelayMs`.  After the final attempt the last error is
 * re-thrown.
 *
 * @param fn - The async operation to retry.
 * @param policy - Retry configuration.
 * @returns The resolved value of `fn` on success.
 * @throws The last error encountered after all attempts are exhausted.
 *
 * @example
 * ```ts
 * const data = await retryWithBackoff(
 *   () => fetch("https://api.example.com/data"),
 *   { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000 },
 * );
 * ```
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (attempt === policy.maxAttempts) {
        break;
      }
      const delay = Math.min(
        policy.baseDelayMs * 2 ** (attempt - 1),
        policy.maxDelayMs,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
