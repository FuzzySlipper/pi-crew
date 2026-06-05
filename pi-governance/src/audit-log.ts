/**
 * AuditLogger — subscribes to all events on the event bus and
 * writes structured JSON log entries with Den correlation IDs.
 *
 * Applies deterministic best-effort secret sealing/redaction at
 * the durable storage boundary, focusing on obvious API keys,
 * tokens, Authorization headers, cookies, and configured secrets.
 *
 * @module pi-governance/audit-log
 */

import type { EventBus, GatewayEvent, Logger } from "@pi-crew/core";

// ── Audit entry shape ──────────────────────────────────────────

/** A single structured audit-log entry. */
export interface AuditEntry {
  /** ISO-8601 timestamp (UTC). */
  readonly timestamp: string;
  /** Dot-style event name (e.g. `"tool.called"`). */
  readonly event: string;
  /** Redacted event payload, serialisable. */
  readonly payload: Record<string, unknown>;
  /** Den correlation IDs extracted from the payload. */
  readonly correlation: AuditCorrelation;
}

/** Correlation IDs pulled from event payloads for traceability. */
export interface AuditCorrelation {
  readonly sessionId?: string;
  readonly assignmentId?: number;
  readonly taskId?: number;
  readonly workerIdentity?: string;
}

/** Callback invoked for every audit entry written. */
export type AuditWriter = (entry: AuditEntry) => void;

// ── Secret patterns ────────────────────────────────────────────

/**
 * Regex patterns that match obvious secret-bearing strings.
 * These are applied BEFORE any user-configured redactions.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer tokens / Authorization headers
  [/\b(?:Bearer|bearer)\s+[^\s"'`,;)]+/, "[REDACTED]"],
  // Basic auth headers
  [/\bBasic\s+[^\s"'`,;)]+/, "[REDACTED]"],
  // Authorization header values
  [/\bAuthorization:\s*[^\n\r]+/gi, "Authorization: [REDACTED]"],
  // Cookie headers
  [/\bCookie:\s*[^\n\r]+/gi, "Cookie: [REDACTED]"],
  // Set-Cookie headers
  [/\bSet-Cookie:\s*[^\n\r]+/gi, "Set-Cookie: [REDACTED]"],
  // OpenAI-style API keys (sk-...)
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
  // Generic API key assignment patterns
  [/\bapi[_-]?key\s*[:=]\s*[^\s"'`,;)]+/gi, "[REDACTED]"],
  // Generic token assignment patterns
  [/\b(?:access_)?token\s*[:=]\s*[^\s"'`,;)]+/gi, "[REDACTED]"],
  // Common credential key=value
  [/\b(?:secret|password|passwd)\s*[:=]\s*[^\s"'`,;)]+/gi, "[REDACTED]"],
  // JWT tokens (three base64url segments separated by dots)
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]"],
];

// ── Redaction engine ───────────────────────────────────────────

/**
 * Apply deterministic redaction to a JSON-stringifiable value.
 *
 * Recurses into objects and arrays. Strings are scanned for
 * known secret patterns and configured extra values.
 */
function redactValue(
  value: unknown,
  extraSecrets: ReadonlySet<string>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    return redactString(value, extraSecrets);
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, extraSecrets));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, extraSecrets);
    }
    return out;
  }

  return value;
}

/**
 * Redact a single string: apply pattern replacements and
 * configured extra-secret substitutions.
 */
function redactString(
  s: string,
  extraSecrets: ReadonlySet<string>,
): string {
  let result = s;

  // Apply regex patterns
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // Apply configured extra secrets (substring match)
  for (const secret of extraSecrets) {
    if (secret.length > 0 && result.includes(secret)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }

  return result;
}

// ── AuditLogger ────────────────────────────────────────────────

/**
 * Subscribes to every {@link GatewayEvent} and writes structured,
 * redacted JSON entries via an {@link AuditWriter} callback.
 *
 * The writer callback is the durable storage boundary — all
 * redaction happens before the callback is invoked.
 */
export class AuditLogger {
  private readonly unsubscribeFns: Array<() => void> = [];
  private readonly extraSecretSet: ReadonlySet<string>;
  private readonly writer: AuditWriter;

  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
    opts: AuditLoggerOptions,
  ) {
    this.extraSecretSet = new Set(opts.extraSecrets ?? []);
    this.writer = opts.writer;
    (opts as { extraSecretSet: ReadonlySet<string> }).extraSecretSet =
      this.extraSecretSet;
    this.subscribe();
  }

  // ── Subscription ────────────────────────────────────────────

  private subscribe(): void {
    const events: Array<GatewayEvent["event"]> = [
      "session.created",
      "session.routing",
      "session.expired",
      "tool.called",
      "tool.completed",
      "blackboard.written",
      "assignment.claimed",
      "assignment.released",
      "turn.started",
      "turn.completed",
      "turn.errored",
      "turn.exhausted",
      "checkpoint.waiting",
      "context.pressure",
      "worker.stuck",
      "gateway.shutdown",
    ];

    for (const evt of events) {
      const unsub = this.eventBus.on(
        evt as never,
        (payload: unknown) => {
          this.writeEntry(evt, payload as Record<string, unknown>);
        },
      );
      this.unsubscribeFns.push(unsub);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Unsubscribe from all events. Call during shutdown. */
  dispose(): void {
    for (const unsub of this.unsubscribeFns) {
      unsub();
    }
    this.unsubscribeFns.length = 0;
  }

  // ── Entry writing ────────────────────────────────────────────

  private writeEntry(
    event: string,
    rawPayload: Record<string, unknown>,
  ): void {
    try {
      const redactedPayload = redactValue(
        rawPayload,
        this.extraSecretSet,
      ) as Record<string, unknown>;

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        event,
        payload: redactedPayload,
        correlation: extractCorrelation(rawPayload),
      };

      this.writer(entry);
    } catch (err: unknown) {
      this.logger.error("AuditLogger: failed to write entry", {
        event,
        error: String(err),
      });
    }
  }
}

// ── Options ────────────────────────────────────────────────────

export interface AuditLoggerOptions {
  /** Called for every audit entry. This is the storage boundary. */
  writer: AuditWriter;
  /**
   * Additional string values to redact from all audit payloads.
   * Useful for configured secrets (API keys, tokens) that don't
   * match the built-in regex patterns.
   */
  extraSecrets?: ReadonlyArray<string>;
  /** Pre-computed set for O(1) lookups (populated by constructor). */
  readonly extraSecretSet?: ReadonlySet<string>;
}

// ── Correlation extraction ─────────────────────────────────────

/**
 * Walk a raw (pre-redaction) event payload and pull out Den
 * correlation IDs for traceability.
 */
function extractCorrelation(
  payload: Record<string, unknown>,
): AuditCorrelation {
  return {
    sessionId:
      typeof payload.sessionId === "string"
        ? payload.sessionId
        : undefined,
    assignmentId:
      typeof payload.assignmentId === "number"
        ? payload.assignmentId
        : undefined,
    taskId:
      typeof payload.taskId === "number"
        ? payload.taskId
        : undefined,
    workerIdentity:
      typeof payload.workerIdentity === "string"
        ? payload.workerIdentity
        : undefined,
  };
}
