import { describe, it, expect } from "vitest";
import type { Logger, LogContext } from "./logging.js";

/**
 * An in-memory logger that captures calls for test assertions.
 */
class MemoryLogger implements Logger {
  public readonly records: Array<{
    level: string;
    message: string;
    context?: LogContext;
  }> = [];

  debug(message: string, context?: LogContext): void {
    this.records.push({ level: "debug", message, context });
  }
  info(message: string, context?: LogContext): void {
    this.records.push({ level: "info", message, context });
  }
  warn(message: string, context?: LogContext): void {
    this.records.push({ level: "warn", message, context });
  }
  error(message: string, context?: LogContext): void {
    this.records.push({ level: "error", message, context });
  }
}

describe("Logger interface", () => {
  it("can be implemented by a memory logger", () => {
    const logger = new MemoryLogger();
    logger.info("session created", { sessionId: "s1" });
    logger.warn("retry", { attempt: 2 });
    logger.error("crash", { stack: "..." });
    logger.debug("trace", {});

    expect(logger.records).toHaveLength(4);
    expect(logger.records[0]).toEqual({
      level: "info",
      message: "session created",
      context: { sessionId: "s1" },
    });
    expect(logger.records[1]?.level).toBe("warn");
    expect(logger.records[2]?.level).toBe("error");
    expect(logger.records[3]?.level).toBe("debug");
  });

  it("allows logging without context", () => {
    const logger = new MemoryLogger();
    logger.info("bare message");
    const r0 = logger.records[0];
    expect(r0).toBeDefined();
    if (r0) {
      expect(r0.context).toBeUndefined();
    }
  });
});
