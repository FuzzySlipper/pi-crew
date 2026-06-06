/**
 * Tests for user-service journal logging helpers.
 *
 * @module pi-crew/__tests__/service-logger
 */

import { describe, expect, it, vi } from "vitest";
import { FakeEventBus } from "@pi-crew/core";

import {
  ServiceConsoleLogger,
  subscribeServiceEventLogs,
} from "../service-logger.js";

describe("ServiceConsoleLogger", () => {
  it("redacts secret-looking context before writing to stdout", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new ServiceConsoleLogger({ level: "debug", json: true });

    logger.info("redaction test", {
      channelsToken: "super-secret-token",
      header: "Bearer abcdef1234567890",
      nested: { password: "do-not-log" },
    });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("super-secret-token");
    expect(output).not.toContain("abcdef1234567890");
    expect(output).not.toContain("do-not-log");

    logSpy.mockRestore();
  });

  it("subscribes high-signal runtime events for journal evidence", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const eventBus = new FakeEventBus();
    const logger = new ServiceConsoleLogger({ level: "info", json: false });
    const unsubscribe = subscribeServiceEventLogs(eventBus, logger);

    eventBus.emit({
      event: "tool.completed",
      payload: {
        toolName: "deterministic_arithmetic_sum",
        sessionId: "inst-1",
        success: true,
        durationMs: 1,
        result: { responseText: "NON_ECHO_RUNTIME_OK:42" },
      },
    });

    unsubscribe();

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Runtime tool completed");
    expect(output).toContain("deterministic_arithmetic_sum");
    expect(output).toContain("NON_ECHO_RUNTIME_OK:42");

    logSpy.mockRestore();
  });
});
