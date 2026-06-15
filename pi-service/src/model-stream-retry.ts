import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { EventBus, ModelStreamRetryPayload } from "@pi-crew/core";

export interface StreamRetryConfig {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
  readonly retryableHttpStatuses: readonly number[];
}

export interface StreamRetryCorrelation {
  readonly sessionId: string;
  readonly profileId?: string;
  readonly assignmentId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly role?: string;
}

export interface RetryingStreamOptions {
  readonly config: StreamRetryConfig;
  readonly eventBus?: Pick<EventBus, "emit">;
  readonly correlation: StreamRetryCorrelation;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly random?: () => number;
}

interface ErrorClassification {
  readonly retryable: boolean;
  readonly reason: string;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly retryAfterMs?: number;
}

export const DEFAULT_STREAM_RETRY_CONFIG: StreamRetryConfig = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
  retryableHttpStatuses: [408, 429, 502, 503, 504],
};

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
]);

const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 409, 413, 422]);

export function withRetryingStream<TApi extends Api = Api>(
  streamFn: StreamFunction<TApi, SimpleStreamOptions>,
  options: RetryingStreamOptions,
): StreamFunction<TApi, SimpleStreamOptions> {
  if (!options.config.enabled) return streamFn;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;
  return (model, context, streamOptions) => {
    const output = createAssistantMessageEventStream();
    void pumpWithRetries(streamFn, model, context, streamOptions, output, options, sleep, random);
    return output;
  };
}

async function pumpWithRetries<TApi extends Api>(
  streamFn: StreamFunction<TApi, SimpleStreamOptions>,
  model: Model<TApi>,
  context: Context,
  streamOptions: SimpleStreamOptions | undefined,
  output: AssistantMessageEventStream,
  options: RetryingStreamOptions,
  sleep: (delayMs: number) => Promise<void>,
  random: () => number,
): Promise<void> {
  let attempt = 1;
  while (attempt <= options.config.maxAttempts) {
    const buffered: AssistantMessageEvent[] = [];
    let visibleOutputStarted = false;
    let lastPartial: AssistantMessage | undefined;
    try {
      const upstream = streamFn(model, context, streamOptions);
      for await (const event of upstream) {
        lastPartial = partialFromEvent(event) ?? lastPartial;
        if (!visibleOutputStarted && event.type === "start") {
          buffered.push(event);
          continue;
        }
        if (!visibleOutputStarted) {
          visibleOutputStarted = true;
          for (const bufferedEvent of buffered) output.push(bufferedEvent);
        }
        output.push(event);
        if (event.type === "done") {
          output.end(event.message);
          return;
        }
        if (event.type === "error") {
          output.end(event.error);
          return;
        }
      }
      const result = await upstream.result();
      output.end(result);
      return;
    } catch (error: unknown) {
      const classification = classifyStreamError(error, options.config.retryableHttpStatuses);
      if (visibleOutputStarted) {
        emitRetryEvent("model.stream.partial_failure", options, model, attempt, classification);
        output.push({ type: "error", reason: "error", error: errorAssistant(model, classification, lastPartial) });
        output.end(errorAssistant(model, classification, lastPartial));
        return;
      }
      if (!classification.retryable || attempt >= options.config.maxAttempts) {
        emitRetryEvent("model.stream.retry_exhausted", options, model, attempt, classification);
        output.push({ type: "error", reason: "error", error: errorAssistant(model, classification, lastPartial) });
        output.end(errorAssistant(model, classification, lastPartial));
        return;
      }
      const delayMs = retryDelayMs(attempt, options.config, classification, random);
      emitRetryEvent("model.stream.retry_scheduled", options, model, attempt, classification, delayMs);
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

export function classifyStreamError(
  error: unknown,
  retryableHttpStatuses: readonly number[] = DEFAULT_STREAM_RETRY_CONFIG.retryableHttpStatuses,
): ErrorClassification {
  const record = toRecord(error);
  const statusCode = readStatusCode(record);
  const errorCode = readString(record, "code") ?? readString(record, "errorCode");
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  if (isAbort(errorCode, lowerMessage)) return { retryable: false, reason: "aborted", statusCode, errorCode };
  if (statusCode !== undefined) {
    if (retryableHttpStatuses.includes(statusCode)) {
      return { retryable: true, reason: `http_${String(statusCode)}`, statusCode, errorCode, retryAfterMs: readRetryAfterMs(record) };
    }
    if (PERMANENT_STATUS_CODES.has(statusCode)) {
      return { retryable: false, reason: `http_${String(statusCode)}`, statusCode, errorCode };
    }
  }
  if (errorCode !== undefined && RETRYABLE_NETWORK_CODES.has(errorCode)) {
    return { retryable: true, reason: errorCode, statusCode, errorCode };
  }
  if (isContextOverflow(lowerMessage)) return { retryable: false, reason: "context_overflow", statusCode, errorCode };
  if (isAuthOrConfig(lowerMessage)) return { retryable: false, reason: "auth_or_config", statusCode, errorCode };
  if (isInvalidRequest(lowerMessage)) return { retryable: false, reason: "invalid_request", statusCode, errorCode };
  if (isTemporaryBackend(lowerMessage)) return { retryable: true, reason: "temporary_backend", statusCode, errorCode };
  return { retryable: false, reason: "unknown", statusCode, errorCode };
}

export function retryDelayMs(
  attempt: number,
  config: StreamRetryConfig,
  classification: ErrorClassification,
  random: () => number = Math.random,
): number {
  if (classification.retryAfterMs !== undefined) return Math.min(classification.retryAfterMs, config.maxDelayMs);
  const exponential = Math.min(config.baseDelayMs * 2 ** Math.max(0, attempt - 1), config.maxDelayMs);
  const jitterRange = exponential * config.jitterRatio;
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(Math.min(config.maxDelayMs, exponential + jitter)));
}

function emitRetryEvent(
  event: "model.stream.retry_scheduled" | "model.stream.retry_exhausted" | "model.stream.partial_failure",
  options: RetryingStreamOptions,
  model: Model<Api>,
  attempt: number,
  classification: ErrorClassification,
  delayMs?: number,
): void {
  const payload: ModelStreamRetryPayload = {
    ...options.correlation,
    provider: model.provider,
    model: model.id,
    attempt,
    maxAttempts: options.config.maxAttempts,
    retryable: classification.retryable,
    reason: classification.reason,
    ...(classification.statusCode === undefined ? {} : { statusCode: classification.statusCode }),
    ...(classification.errorCode === undefined ? {} : { errorCode: classification.errorCode }),
    ...(delayMs === undefined ? {} : { delayMs }),
    occurredAt: new Date().toISOString(),
  };
  options.eventBus?.emit({ event, payload });
}

function partialFromEvent(event: AssistantMessageEvent): AssistantMessage | undefined {
  if ("partial" in event) return event.partial;
  return event.type === "done" ? event.message : event.error;
}

function errorAssistant<TApi extends Api>(
  model: Model<TApi>,
  classification: ErrorClassification,
  partial: AssistantMessage | undefined,
): AssistantMessage {
  return {
    ...(partial ?? emptyAssistant(model)),
    stopReason: "error",
    errorMessage: `model stream failed: ${classification.reason}`,
  };
}

function emptyAssistant<TApi extends Api>(model: Model<TApi>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    timestamp: Date.now(),
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function readStatusCode(record: Record<string, unknown>): number | undefined {
  const value = record["status"] ?? record["statusCode"] ?? record["code"];
  return typeof value === "number" ? value : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRetryAfterMs(record: Record<string, unknown>): number | undefined {
  const headers = toRecord(record["headers"]);
  const retryAfter = readString(headers, "retry-after") ?? readString(headers, "Retry-After");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function isAbort(code: string | undefined, message: string): boolean {
  return code === "ABORT_ERR" || message.includes("abort") || message.includes("cancelled") || message.includes("canceled");
}

function isContextOverflow(message: string): boolean {
  return message.includes("context") && (message.includes("overflow") || message.includes("too long") || message.includes("maximum context"));
}

function isAuthOrConfig(message: string): boolean {
  return message.includes("auth") || message.includes("api key") || message.includes("unauthorized") || message.includes("forbidden") || message.includes("configuration");
}

function isInvalidRequest(message: string): boolean {
  return message.includes("invalid request") || message.includes("schema") || message.includes("bad request") || message.includes("tool execution") || message.includes("tool-call");
}

function isTemporaryBackend(message: string): boolean {
  return message.includes("temporar") || message.includes("capacity") || message.includes("backend unavailable") || message.includes("rate limit") || message.includes("timeout") || message.includes("connection reset") || message.includes("connection refused");
}
