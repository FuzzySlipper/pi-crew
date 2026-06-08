/** WorkerRuntime active Agent registry integration tests. */

import { describe, expect, it, vi } from "vitest";
import { FakeEventBus, FakeLogger } from "@pi-crew/core";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { WorkerRuntime, type WorkerExecutor } from "../../workers/worker-runtime.js";
import { AgentRuntimeRegistry } from "../../workers/agent-runtime-registry.js";
import type { SteerableAgent } from "../../workers/agent-supervisor.js";
import {
  FakeAuditRepo,
  FakeSessionManager,
  makeAcceptingPoster,
  makeBinding,
  makeFakePool,
  makeRoleMapping,
} from "./worker-runtime-test-fixtures.js";

class FakeSteerableAgent implements SteerableAgent {
  readonly steer = vi.fn((message: AgentMessage) => { void message; });
  readonly followUp = vi.fn((message: AgentMessage) => { void message; });
  readonly hasQueuedMessages = vi.fn(() => false);

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    void listener;
    return () => undefined;
  }
}

describe("WorkerRuntime AgentRuntimeRegistry integration", () => {
  it("registers steerable Agents while active and unregisters on release", async () => {
    const registry = new AgentRuntimeRegistry();
    const binding = makeBinding({ assignmentId: "959", runId: "piw_ingress" });
    const executor: WorkerExecutor = {
      execute(context) {
        const agent = new FakeSteerableAgent();
        const supervisor = context.createAgentSupervisor(agent);
        supervisor.start();

        const entry = registry.findByRunId("piw_ingress");
        expect(entry?.agent).toBe(agent);
        expect(registry.findByAssignmentId("959")?.supervisor.isActive).toBe(true);

        supervisor.stop();
        return Promise.resolve({
          status: "completed",
          artifacts: [{ type: "test", ref: "registry", summary: "registered" }],
          filesTouched: [],
          toolsUsed: [],
          tokensConsumed: 0,
          summary: "done",
        });
      },
    };

    const runtime = new WorkerRuntime(
      { workerIdentity: "test-worker", agentRuntimeRegistry: registry },
      makeRoleMapping(),
      new FakeSessionManager(),
      makeFakePool(),
      new FakeEventBus(),
      new FakeLogger(),
      new FakeAuditRepo(),
      makeAcceptingPoster(),
    );

    await runtime.executeAssignment(binding, executor);

    expect(registry.findByRunId("piw_ingress")).toBeUndefined();
    expect(registry.findByAssignmentId("959")).toBeUndefined();
  });
});
