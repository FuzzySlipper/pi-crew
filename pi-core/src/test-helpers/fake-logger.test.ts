import { describe, it, expect, beforeEach } from "vitest";
import { FakeLogger } from "./fake-logger.js";
import type { Logger } from "../logging.js";

describe("FakeLogger", () => {
  let logger: FakeLogger;

  beforeEach(() => {
    logger = new FakeLogger();
  });

  it("satisfies the Logger interface", () => {
    const l: Logger = logger;
    expect(l).toBe(logger);
  });

  it("records entries in chronological order", () => {
    logger.info("first");
    logger.debug("second");
    logger.warn("third");
    logger.error("fourth");

    expect(logger.entries).toHaveLength(4);

    const e0 = logger.entries[0];
    expect(e0).toBeDefined();
    if (e0) {
      expect(e0.message).toBe("first");
      expect(e0.level).toBe("info");
    }

    const e1 = logger.entries[1];
    expect(e1).toBeDefined();
    if (e1) {
      expect(e1.message).toBe("second");
      expect(e1.level).toBe("debug");
    }

    const e2 = logger.entries[2];
    expect(e2).toBeDefined();
    if (e2) {
      expect(e2.message).toBe("third");
      expect(e2.level).toBe("warn");
    }

    const e3 = logger.entries[3];
    expect(e3).toBeDefined();
    if (e3) {
      expect(e3.message).toBe("fourth");
      expect(e3.level).toBe("error");
    }
  });

  it("preserves level for each entry", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(logger.entries.map((e) => e.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("preserves structured context when provided", () => {
    logger.info("session created", {
      sessionId: "s1",
      kind: "worker",
    });

    const entry = logger.entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      expect(entry.message).toBe("session created");
      expect(entry.context).toEqual({ sessionId: "s1", kind: "worker" });
    }
  });

  it("omits context when not provided", () => {
    logger.info("bare message");
    const entry = logger.entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      expect(entry.context).toBeUndefined();
    }
  });

  it("sets a timestamp on every entry", () => {
    const before = new Date();
    logger.info("msg");
    const after = new Date();

    const entry = logger.entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(entry.timestamp.getTime()).toBeLessThanOrEqual(
        after.getTime(),
      );
    }
  });

  it("clear removes all entries", () => {
    logger.info("a");
    logger.info("b");
    expect(logger.entries).toHaveLength(2);
    logger.clear();
    expect(logger.entries).toHaveLength(0);
  });

  it("supports complex context values", () => {
    logger.warn("retry", {
      attempt: 3,
      maxAttempts: 5,
      lastError: "ECONNREFUSED",
      nested: { key: "value" },
    });

    const entry = logger.entries[0];
    expect(entry).toBeDefined();
    if (entry) {
      expect(entry.context).toEqual({
        attempt: 3,
        maxAttempts: 5,
        lastError: "ECONNREFUSED",
        nested: { key: "value" },
      });
    }
  });

  it("log entries array has correct shape after mixed calls", () => {
    logger.debug("trace", { a: 1 });
    logger.info("info msg");
    logger.error("crash", { stack: "..." });

    expect(logger.entries).toHaveLength(3);

    const debugEntry = logger.entries[0];
    expect(debugEntry).toBeDefined();
    if (debugEntry) {
      expect(debugEntry.level).toBe("debug");
      expect(debugEntry.message).toBe("trace");
      expect(debugEntry.context).toEqual({ a: 1 });
      expect(debugEntry.timestamp).toBeInstanceOf(Date);
    }

    const infoEntry = logger.entries[1];
    expect(infoEntry).toBeDefined();
    if (infoEntry) {
      expect(infoEntry.level).toBe("info");
      expect(infoEntry.message).toBe("info msg");
      expect(infoEntry.context).toBeUndefined();
      expect(infoEntry.timestamp).toBeInstanceOf(Date);
    }

    const errorEntry = logger.entries[2];
    expect(errorEntry).toBeDefined();
    if (errorEntry) {
      expect(errorEntry.level).toBe("error");
      expect(errorEntry.message).toBe("crash");
      expect(errorEntry.context).toEqual({ stack: "..." });
      expect(errorEntry.timestamp).toBeInstanceOf(Date);
    }
  });
});
