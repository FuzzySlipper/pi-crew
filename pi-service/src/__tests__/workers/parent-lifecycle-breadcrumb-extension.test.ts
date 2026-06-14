import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, InMemoryBreadcrumbRepository } from "@pi-crew/core";
import { ParentLifecycleBreadcrumbExtension } from "../../workers/parent-lifecycle-breadcrumb-extension.js";
import type { ServiceExtensionContext } from "../../extension-activator.js";

function context(eventBus: FakeEventBus, logger: FakeLogger): ServiceExtensionContext {
  return {
    eventBus,
    logger,
    config: undefined as unknown as ServiceExtensionContext["config"],
    hookRegistry: undefined as unknown as ServiceExtensionContext["hookRegistry"],
    delegationSessions: undefined as unknown as ServiceExtensionContext["delegationSessions"],
  };
}

describe("ParentLifecycleBreadcrumbExtension", () => {
  it("persists parent routing, turn, and tool lifecycle rows", async () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const repository = new InMemoryBreadcrumbRepository();
    const extension = new ParentLifecycleBreadcrumbExtension({
      repository,
      logger,
      bindings: [{
        sessionId: "sess-prime-coder",
        channelId: "642",
        projectId: "pi-crew",
        agentIdentity: "prime-coder",
        profileId: "prime-coder",
        provider: "openrouter",
        model: "gpt-5.5",
      }],
    });
    await extension.activate(context(eventBus, logger));

    eventBus.emit({ event: "session.routing", payload: { sessionId: "sess-prime-coder", channelId: "642", reason: "existing_session" } });
    eventBus.emit({ event: "turn.started", payload: { sessionId: "sess-prime-coder", turnNumber: 1 } });
    eventBus.emit({ event: "tool.called", payload: { sessionId: "sess-prime-coder", toolName: "get_task" } });
    eventBus.emit({ event: "tool.completed", payload: { sessionId: "sess-prime-coder", toolName: "get_task", success: true, durationMs: 12 } });
    eventBus.emit({ event: "turn.completed", payload: { sessionId: "sess-prime-coder", turnNumber: 1, durationMs: 99 } });

    const rows = repository.getAll();
    expect(rows.map((row) => row.eventType)).toEqual(expect.arrayContaining([
      "pi_crew.parent.runtime_received",
      "pi_crew.parent.request_claimed",
      "pi_crew.parent.turn_started",
      "pi_crew.parent.completed",
    ]));
    const toolRows = rows.filter((row) => row.eventFamily === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].state).toBe("completed");
    expect(toolRows[0].ownerSessionId).toBe("sess-prime-coder");
  });
});
