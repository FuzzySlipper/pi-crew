import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, InMemoryBreadcrumbRepository } from "@pi-crew/core";
import type { DelegationSpawnedPayload, DelegationToolVisiblePayload } from "@pi-crew/core";
import { DenDelegationProjectionExtension } from "../../workers/den-delegation-projection.js";
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

function spawned(): DelegationSpawnedPayload {
  return {
    childSessionId: "child-1",
    lineage: {
      parentSessionId: "parent-1",
      rootSessionId: "root-1",
      childSessionId: "child-1",
      depth: 1,
      chain: ["root-1", "child-1"],
    },
    policyId: "policy-1",
    task: "Read task 2414 and inspect breadcrumb code",
    effectiveRuntime: { profileId: "coder-worker", provider: "openrouter", model: "gpt-5.5" },
  };
}

function tool(phase: "called" | "completed" | "denied"): DelegationToolVisiblePayload {
  return {
    childSessionId: "child-1",
    lineage: spawned().lineage,
    policyId: "policy-1",
    toolName: "get_task",
    toolCallId: "tool-1",
    phase,
    durationMs: phase === "completed" ? 42 : undefined,
  };
}

describe("DenDelegationProjectionExtension structured breadcrumbs", () => {
  it("persists spawned and coalesced tool rows without channel debug projection", async () => {
    const eventBus = new FakeEventBus();
    const logger = new FakeLogger();
    const repository = new InMemoryBreadcrumbRepository();
    const extension = new DenDelegationProjectionExtension({
      loggerEnabled: false,
      channelEnabled: false,
      breadcrumbRepository: repository,
      projectId: "pi-crew",
      channelId: "642",
      parentAgentIdentity: "prime-coder",
    });
    await extension.activate(context(eventBus, logger));

    eventBus.emit({ event: "delegation.spawned", payload: spawned() });
    eventBus.emit({ event: "delegation.tool_visible", payload: tool("called") });
    eventBus.emit({ event: "delegation.tool_visible", payload: tool("completed") });

    const all = repository.getAll();
    expect(all.map((row) => row.eventType)).toContain("pi_crew.delegation.spawned");
    const toolRows = all.filter((row) => row.eventFamily === "tool");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].toolCallId).toBe("tool-1");
    expect(toolRows[0].phase).toBe("completed");
    expect(toolRows[0].durationMs).toBe(42);
  });
});
