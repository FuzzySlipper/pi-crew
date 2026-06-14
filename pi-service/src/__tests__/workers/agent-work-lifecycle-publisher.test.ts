import { describe, expect, it } from "vitest";
import { createDelegationBreadcrumb, createParentBreadcrumb, createToolBreadcrumb, FakeLogger, InMemoryBreadcrumbRepository } from "@pi-crew/core";
import {
  HttpAgentWorkLifecyclePublisher,
  PublishingAgentWorkBreadcrumbRepository,
  toLifecyclePayload,
} from "../../workers/agent-work-lifecycle-publisher.js";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

class RecordingPublisher {
  readonly published: string[] = [];

  publish(breadcrumb: { readonly id: string }): Promise<void> {
    this.published.push(breadcrumb.id);
    return Promise.resolve();
  }
}

class FailingPublisher {
  publish(): Promise<void> {
    return Promise.reject(new Error("boom"));
  }
}

class RecordingFetch {
  readonly calls: FetchCall[] = [];

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 201 }));
  };
}

describe("PublishingAgentWorkBreadcrumbRepository", () => {
  it("publishes appended and coalesced updated breadcrumbs without replacing local persistence", async () => {
    const inner = new InMemoryBreadcrumbRepository();
    const publisher = new RecordingPublisher();
    const repository = new PublishingAgentWorkBreadcrumbRepository({ inner, publisher });
    const breadcrumb = createToolBreadcrumb({
      id: "bc-tool-1",
      projectId: "pi-crew",
      channelId: "642",
      eventFamily: "tool",
      eventType: "pi_crew.delegation.tool_called",
      state: "interim",
      severity: "debug",
      summary: "Subagent tool called: get_task",
      evidence: { childSessionId: "delegated-session-7", toolCallId: "call-1" },
      metadata: { parentSessionId: "sess-prime", rootSessionId: "sess-prime", profileId: "coder-worker" },
      toolName: "get_task",
      toolCallId: "call-1",
      phase: "called",
      isError: false,
      resultClass: "ok",
      ownerSessionId: "delegated-session-7",
    });

    await repository.append(breadcrumb);
    await repository.updateByCorrelation(
      { eventFamily: "tool", childSessionId: "delegated-session-7", toolCallId: "call-1" },
      { state: "completed", phase: "completed", durationMs: 17 },
    );

    expect(inner.getAll()).toHaveLength(1);
    expect(publisher.published).toEqual(["bc-tool-1", "bc-tool-1"]);
    const storedRows = inner.getAll();
    expect(storedRows[0]?.state).toBe("completed");
  });

  it("keeps local writes successful when canonical lifecycle publishing fails", async () => {
    const logger = new FakeLogger();
    const inner = new InMemoryBreadcrumbRepository();
    const repository = new PublishingAgentWorkBreadcrumbRepository({
      inner,
      publisher: new FailingPublisher(),
      logger,
    });

    const saved = await repository.append(createParentBreadcrumb({
      id: "bc-parent-1",
      projectId: "pi-crew",
      channelId: "642",
      eventFamily: "parent",
      eventType: "pi_crew.parent.turn_started",
      state: "started",
      severity: "info",
      summary: "Full agent turn started",
      evidence: { sessionId: "sess-prime" },
      metadata: {},
      agentIdentity: "prime-coder",
      profileId: "prime-coder",
      sessionId: "sess-prime",
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved.id).toBe("bc-parent-1");
    expect(inner.getAll()).toHaveLength(1);
  });
});

describe("toLifecyclePayload", () => {
  it("maps structured delegation/tool fields into non-waking Den Channels lifecycle payload metadata", () => {
    const payload = toLifecyclePayload(createToolBreadcrumb({
      id: "bc-tool-2",
      createdAt: "2026-06-14T23:00:00.000Z",
      projectId: "pi-crew",
      channelId: "642",
      eventFamily: "tool",
      eventType: "pi_crew.delegation.tool_completed",
      state: "completed",
      severity: "debug",
      summary: "Subagent tool completed: get_task",
      evidence: { childSessionId: "delegated-session-7", toolCallId: "call-1" },
      metadata: { parentSessionId: "sess-prime", rootSessionId: "sess-prime", profileId: "coder-worker" },
      toolName: "get_task",
      toolCallId: "call-1",
      phase: "completed",
      durationMs: 17,
      isError: false,
      resultClass: "ok",
      ownerSessionId: "delegated-session-7",
    }));

    expect(payload).toMatchObject({
      channelId: 642,
      eventType: "checkpoint_seen",
      projectId: "pi-crew",
      sessionId: "delegated-session-7",
      parentSessionId: "sess-prime",
      workerRunId: "delegated-session-7",
      workerRole: "subagent",
      displayBlockId: "pi-crew-delegation:delegated-session-7",
      stateReason: "Subagent tool completed: get_task",
    });
    expect(JSON.parse(payload.metadataJson)).toMatchObject({
      source: "pi-crew",
      eventFamily: "tool",
      piCrewEventType: "pi_crew.delegation.tool_completed",
      childSessionId: "delegated-session-7",
      parentSessionId: "sess-prime",
      toolName: "get_task",
      toolCallId: "call-1",
      phase: "completed",
      durationMs: 17,
    });
  });

  it("maps terminal delegation rows to canonical completed lifecycle events", () => {
    const payload = toLifecyclePayload(createDelegationBreadcrumb({
      id: "bc-child-1",
      createdAt: "2026-06-14T23:00:00.000Z",
      projectId: "pi-crew",
      channelId: "642",
      eventFamily: "delegation",
      eventType: "pi_crew.delegation.completed",
      state: "completed",
      severity: "info",
      summary: "Subagent completed: success",
      evidence: { childSessionId: "delegated-session-7" },
      metadata: {},
      parentAgentIdentity: "pi-orchestrator",
      parentSessionId: "sess-prime",
      rootSessionId: "sess-prime",
      childSessionId: "delegated-session-7",
      profileId: "coder-worker",
      policyId: "delegated-implementation",
      depth: 1,
      outcome: "success",
    }));

    expect(payload.eventType).toBe("completed");
    expect(payload.agentIdentity).toBe("coder-worker");
    expect(payload.parentAgentIdentity).toBe("pi-orchestrator");
    expect(payload.stalenessDeadline).toBeUndefined();
  });
});

describe("HttpAgentWorkLifecyclePublisher", () => {
  it("posts to the canonical lifecycle endpoint instead of channel messages", async () => {
    const recorder = new RecordingFetch();
    const publisher = new HttpAgentWorkLifecyclePublisher({
      baseUrl: "http://den-channels.test/",
      token: "token-1",
      fetchFn: recorder.fetch,
    });

    await publisher.publish(createParentBreadcrumb({
      id: "bc-parent-2",
      projectId: "pi-crew",
      channelId: "642",
      eventFamily: "parent",
      eventType: "pi_crew.parent.runtime_received",
      state: "started",
      severity: "info",
      summary: "Full agent routed",
      evidence: { sessionId: "sess-prime" },
      metadata: {},
      agentIdentity: "prime-coder",
      profileId: "prime-coder",
      sessionId: "sess-prime",
    }));

    expect(recorder.calls).toHaveLength(1);
    const firstCall = recorder.calls[0];
    if (firstCall === undefined) throw new Error("expected fetch call");
    expect(firstCall.url).toBe("http://den-channels.test/api/agent-work/lifecycle-events");
    expect(firstCall.init.method).toBe("POST");
    expect(firstCall.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer token-1",
    });
    expect(JSON.parse(String(firstCall.init.body))).toMatchObject({
      eventType: "runtime_received",
      displayBlockId: "pi-crew-agent:prime-coder:sess-prime",
    });
  });
});
