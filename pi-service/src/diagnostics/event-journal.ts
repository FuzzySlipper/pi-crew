/** Bounded in-memory event journal for read-only diagnostics. */
import type { EventBus, GatewayEvent } from "@pi-crew/core";
import type { DiagnosticEventRecord } from "./types.js";

interface JournalOptions {
  readonly maxRecords?: number;
  readonly clock?: () => string;
}

const DEFAULT_MAX_RECORDS = 100;
const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|password|secret|token)/i;
const TOKEN_TEXT_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,}]+/gi;

const JOURNALED_EVENTS: readonly GatewayEvent["event"][] = [
  "session.created",
  "session.routing",
  "session.expired",
  "tool.called",
  "tool.completed",
  "blackboard.written",
  "assignment.claimed",
  "assignment.released",
  "assignment.timed_out",
  "turn.started",
  "turn.completed",
  "turn.errored",
  "turn.exhausted",
  "checkpoint.waiting",
  "context.pressure",
  "worker.stuck",
  "gateway.shutdown",
  "tool.denied",
  "drain.activated",
  "drain.deactivated",
  "policy.enforced",
  "completion.posted",
  "session.rehydrated",
  "session.presence",
  "admin.control.requested",
  "admin.control.completed",
];

/**
 * Captures redacted recent GatewayEvents for diagnostics. The journal is
 * observational only; it never becomes workflow authority.
 */
export class InMemoryDiagnosticEventJournal {
  readonly #records: DiagnosticEventRecord[] = [];
  readonly #maxRecords: number;
  readonly #clock: () => string;
  #nextSequence = 1;

  constructor(eventBus: EventBus, options: JournalOptions = {}) {
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#clock = options.clock ?? (() => new Date().toISOString());

    for (const eventName of JOURNALED_EVENTS) {
      eventBus.on(eventName, (payload) => {
        this.#append(eventName, payload);
      });
    }
  }

  recent(limit = this.#maxRecords): DiagnosticEventRecord[] {
    const bounded = Math.max(0, Math.min(limit, this.#maxRecords));
    return this.#records.slice(-bounded);
  }

  #append(event: GatewayEvent["event"], payload: unknown): void {
    this.#records.push({
      sequence: this.#nextSequence,
      observedAt: this.#clock(),
      event,
      payload: redactDiagnosticValue(payload, null),
    });
    this.#nextSequence += 1;

    while (this.#records.length > this.#maxRecords) {
      this.#records.shift();
    }
  }
}

export function redactDiagnosticValue(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_KEY_PATTERN.test(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, null));
  if (isRecord(value)) return redactRecord(value);
  return value;
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactDiagnosticValue(entryValue, entryKey);
  }
  return output;
}

function redactString(value: string): string {
  return value
    .replace(TOKEN_TEXT_PATTERN, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTED}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
