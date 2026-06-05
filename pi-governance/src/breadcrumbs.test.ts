/**
 * Tests for BreadcrumbManager.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  FakeEventBus,
  FakeChannelProvider,
  FakeLogger,
} from "@pi-crew/core";
import { BreadcrumbManager } from "./breadcrumbs.js";

/** Flush pending microtasks so async breadcrumb operations complete. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BreadcrumbManager", () => {
  let eventBus: FakeEventBus;
  let channelProvider: FakeChannelProvider;
  let logger: FakeLogger;
  let manager: BreadcrumbManager;

  beforeEach(() => {
    eventBus = new FakeEventBus();
    channelProvider = new FakeChannelProvider();
    logger = new FakeLogger();
    manager = new BreadcrumbManager(eventBus, channelProvider, logger);
  });

  it("emits a breadcrumb for tool.called", async () => {
    eventBus.emit({
      event: "tool.called",
      payload: { toolName: "read_file", sessionId: "s1" },
    });
    await flush();
    expect(channelProvider.breadcrumbs).toHaveLength(1);
    const bc = channelProvider.breadcrumbs[0];
    expect(bc).toBeDefined();
    expect(bc.category).toBe("tool");
    expect(bc.status).toBe("started");
    expect(bc.description).toContain("Called read_file");
  });

  it("updates breadcrumb from started to completed on success", async () => {
    eventBus.emit({
      event: "tool.called",
      payload: { toolName: "write_file", sessionId: "s1" },
    });
    await flush();
    eventBus.emit({
      event: "tool.completed",
      payload: {
        toolName: "write_file",
        sessionId: "s1",
        success: true,
        durationMs: 42,
      },
    });
    await flush();
    expect(channelProvider.breadcrumbUpdates).toHaveLength(1);
    const update = channelProvider.breadcrumbUpdates[0];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("completed");
    expect(update.update.description).toContain("completed");
  });

  it("updates breadcrumb to failed on tool.completed failure", async () => {
    eventBus.emit({
      event: "tool.called",
      payload: { toolName: "terminal", sessionId: "s2" },
    });
    await flush();
    eventBus.emit({
      event: "tool.completed",
      payload: {
        toolName: "terminal",
        sessionId: "s2",
        success: false,
        durationMs: 10,
      },
    });
    await flush();
    expect(channelProvider.breadcrumbUpdates).toHaveLength(1);
    const update = channelProvider.breadcrumbUpdates[0];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("failed");
    expect(update.update.description).toContain("failed");
  });

  it("emits a standalone breadcrumb for assignment.claimed", async () => {
    eventBus.emit({
      event: "assignment.claimed",
      payload: {
        assignmentId: 42,
        workerIdentity: "pool-coder-01",
        taskId: 123,
      },
    });
    await flush();
    expect(channelProvider.breadcrumbs).toHaveLength(1);
    const bc = channelProvider.breadcrumbs[0];
    expect(bc).toBeDefined();
    expect(bc.category).toBe("worker");
    expect(bc.status).toBe("completed");
    expect(bc.description).toContain("pool-coder-01");
    expect(bc.description).toContain("42");
  });

  it("emits start/complete lifecycle for turns", async () => {
    eventBus.emit({
      event: "turn.started",
      payload: { sessionId: "s1", turnNumber: 3 },
    });
    await flush();
    eventBus.emit({
      event: "turn.completed",
      payload: { sessionId: "s1", turnNumber: 3, durationMs: 1500 },
    });
    await flush();
    expect(channelProvider.breadcrumbs).toHaveLength(1);
    expect(channelProvider.breadcrumbUpdates).toHaveLength(1);
    const update = channelProvider.breadcrumbUpdates[0];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("completed");
  });

  it("emits breadcrumb for blackboard.written", async () => {
    eventBus.emit({
      event: "blackboard.written",
      payload: { entryId: "entry-1", sessionId: "s1" },
    });
    await flush();
    expect(channelProvider.breadcrumbs).toHaveLength(1);
    const bc = channelProvider.breadcrumbs[0];
    expect(bc).toBeDefined();
    expect(bc.category).toBe("memory");
    expect(bc.status).toBe("completed");
    expect(bc.description).toContain("entry-1");
  });

  it("falls back to standalone breadcrumb if no prior started event", async () => {
    eventBus.emit({
      event: "tool.completed",
      payload: {
        toolName: "patch",
        sessionId: "s3",
        success: true,
        durationMs: 5,
      },
    });
    await flush();
    expect(channelProvider.breadcrumbs).toHaveLength(1);
    expect(channelProvider.breadcrumbUpdates).toHaveLength(0);
    const bc = channelProvider.breadcrumbs[0];
    expect(bc).toBeDefined();
    expect(bc.status).toBe("completed");
  });

  it("dispose unsubscribes from all events", () => {
    manager.dispose();
    eventBus.emit({
      event: "tool.called",
      payload: { toolName: "test", sessionId: "s1" },
    });
    expect(channelProvider.breadcrumbs).toHaveLength(0);
  });
});
