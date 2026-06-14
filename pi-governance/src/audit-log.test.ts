/**
 * Tests for AuditLogger.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import { AuditLogger, type AuditEntry } from "./audit-log.js";

describe("AuditLogger", () => {
  let eventBus: FakeEventBus;
  let logger: FakeLogger;
  let entries: AuditEntry[];

  beforeEach(() => {
    eventBus = new FakeEventBus();
    logger = new FakeLogger();
    entries = [];
  });

  function createLogger(extraSecrets?: ReadonlyArray<string>): AuditLogger {
    return new AuditLogger(eventBus, logger, {
      writer: (entry: AuditEntry) => { entries.push(entry); },
      extraSecrets,
    });
  }

  it("captures all subscribed events as structured entries", () => {
    createLogger();
    eventBus.emit({ event: "tool.called", payload: { toolName: "write_file", sessionId: "s1" } });
    eventBus.emit({ event: "turn.started", payload: { sessionId: "s1", turnNumber: 1 } });
    eventBus.emit({ event: "session.created", payload: { sessionId: "s1", kind: "full" as const } });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toBeDefined();
    expect(entries[0].event).toBe("tool.called");
    expect(entries[1]).toBeDefined();
    expect(entries[1].event).toBe("turn.started");
    expect(entries[2]).toBeDefined();
    expect(entries[2].event).toBe("session.created");
  });

  it("extracts Den correlation IDs from event payloads", () => {
    createLogger();
    eventBus.emit({ event: "assignment.claimed", payload: { assignmentId: 99, workerIdentity: "coder-1", taskId: 42 } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const corr = entries[0].correlation;
    expect(corr.assignmentId).toBe(99);
    expect(corr.workerIdentity).toBe("coder-1");
    expect(corr.taskId).toBe(42);
  });

  it("includes timestamp in every entry", () => {
    createLogger();
    eventBus.emit({ event: "gateway.shutdown", payload: { reason: "test" } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    expect(entries[0].timestamp).toBeTruthy();
    expect(() => new Date(entries[0].timestamp)).not.toThrow();
  });

  it("redacts Authorization headers in string values", () => {
    createLogger();
    eventBus.emit({ event: "tool.called", payload: { toolName: "api_call", sessionId: "s1", params: { headers: "Authorization: Bearer *** " } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const params = entries[0].payload.params as Record<string, unknown>;
    expect(params.headers).toBe("Authorization: [REDACTED]");
  });

  it("redacts Bearer tokens in string values", () => {
    createLogger();
    eventBus.emit({ event: "tool.completed", payload: { toolName: "fetch", sessionId: "s1", success: true, durationMs: 10, result: { responseText: "Bearer abcdef1234567890abcdef" } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const result = entries[0].payload.result as Record<string, unknown>;
    expect(result.responseText).toContain("[REDACTED]");
  });

  it("redacts API key patterns", () => {
    createLogger();
    eventBus.emit({ event: "tool.called", payload: { toolName: "invoke", sessionId: "s1", params: { config: "api_key=sk-pro...mnop" } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const params = entries[0].payload.params as Record<string, unknown>;
    expect(params.config).toBe("[REDACTED]");
  });

  it("redacts configured extra secret strings", () => {
    createLogger(["my-super-secret-value"]);
    eventBus.emit({ event: "tool.called", payload: { toolName: "env", sessionId: "s1", params: { value: "prefix-my-super-secret-value-suffix" } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const params = entries[0].payload.params as Record<string, unknown>;
    expect(params.value).not.toContain("my-super-secret-value");
    expect(params.value as string).toContain("[REDACTED]");
  });

  it("recursively redacts nested objects and arrays", () => {
    createLogger();
    eventBus.emit({ event: "tool.called", payload: { toolName: "batch", sessionId: "s1", params: { items: [{ key: "Bearer token1" }, { key: "Bearer token2" }], nested: { deep: { authorization: "Authorization: Bearer *** " } } } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const params = entries[0].payload.params as Record<string, unknown>;
    const items = params.items as Array<Record<string, unknown>>;
    expect(items[0]).toBeDefined();
    expect(items[0].key).toBe("[REDACTED]");
    expect(items[1]).toBeDefined();
    expect(items[1].key).toBe("[REDACTED]");
    const nested = params.nested as Record<string, unknown>;
    const deep = nested.deep as Record<string, unknown>;
    expect(deep.authorization).toBe("Authorization: [REDACTED]");
  });

  it("does not redact harmless data", () => {
    createLogger();
    eventBus.emit({ event: "tool.called", payload: { toolName: "read_file", sessionId: "s1", params: { path: "/home/user/config.yaml", offset: 0 } } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toBeDefined();
    const params = entries[0].payload.params as Record<string, unknown>;
    expect(params.path).toBe("/home/user/config.yaml");
    expect(params.offset).toBe(0);
  });

  it("dispose unsubscribes from all events", () => {
    const audit = createLogger();
    audit.dispose();
    eventBus.emit({ event: "tool.called", payload: { toolName: "test", sessionId: "s1" } });
    expect(entries).toHaveLength(0);
  });
});
