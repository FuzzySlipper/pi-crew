/**
 * User-service logger for the pi-crew systemd process.
 *
 * @module pi-crew/service-logger
 */

import type { EventBus, EventPayload, Logger, LogContext } from "@pi-crew/core";

type LogLevel = "debug" | "info" | "warn" | "error";

interface ServiceLoggerOptions {
  readonly level: LogLevel;
  readonly json: boolean;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Console-backed logger used by the long-lived user service.
 */
export class ServiceConsoleLogger implements Logger {
  constructor(private readonly options: ServiceLoggerOptions) {}

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.options.level]) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: sanitizeContext(context ?? {}),
    };

    if (this.options.json) {
      writeConsole(level, JSON.stringify(entry));
      return;
    }

    const suffix = Object.keys(entry.context).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : "";
    writeConsole(level, `${entry.timestamp} ${level.toUpperCase()} ${message}${suffix}`);
  }
}

/**
 * Subscribe to high-signal runtime events that are needed for live-smoke
 * journal evidence.
 */
export function subscribeServiceEventLogs(
  eventBus: EventBus,
  logger: Logger,
): () => void {
  const unsubscribers = [
    eventBus.on("tool.called", (payload) => {
      logToolCalled(logger, payload);
    }),
    eventBus.on("tool.completed", (payload) => {
      logToolCompleted(logger, payload);
    }),
    eventBus.on("session.routing", (payload) => {
      logger.info("Runtime session routed inbound message", {
        sessionId: payload.sessionId,
        channelId: payload.channelId,
        reason: payload.reason,
      });
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}

function logToolCalled(
  logger: Logger,
  payload: EventPayload<"tool.called">,
): void {
  logger.info("Runtime tool called", {
    toolName: payload.toolName,
    sessionId: payload.sessionId,
    params: payload.params,
  });
}

function logToolCompleted(
  logger: Logger,
  payload: EventPayload<"tool.completed">,
): void {
  logger.info("Runtime tool completed", {
    toolName: payload.toolName,
    sessionId: payload.sessionId,
    success: payload.success,
    durationMs: payload.durationMs,
    result: payload.result,
  });
}

function writeConsole(level: LogLevel, line: string): void {
  switch (level) {
    case "debug":
    case "info":
      console.log(line);
      return;
    case "warn":
      console.warn(line);
      return;
    case "error":
      console.error(line);
      return;
  }
}

function sanitizeContext(context: LogContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    result[key] = sanitizeValue(key, value);
  }
  return result;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSecretString(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }
  if (typeof value === "object" && value !== null) {
    const nested: Record<string, unknown> = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      nested[nestedKey] = sanitizeValue(nestedKey, nestedValue);
    }
    return nested;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|passwd|authorization|cookie/u.test(
    key.toLowerCase(),
  );
}

function redactSecretString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'`,;)]+/giu, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[^\s"'`,;)]+/giu, "Basic [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]");
}
