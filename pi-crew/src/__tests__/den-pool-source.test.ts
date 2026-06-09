import { describe, expect, it } from "vitest";
import type { MCPClient, ToolCallResult } from "@pi-crew/mcp";
import {
  DenPoolSourceConfigurationError,
  createDenPoolAssignmentConsumer,
  createDenPoolMemberReconciler,
} from "../den-pool-source.js";
import { CrewConfigSchema } from "../config.js";
import { resolveWorkerPoolMembers } from "../worker-pool-groups.js";

interface RecordedCall {
  readonly name: string;
  readonly params: Record<string, unknown>;
}

class FakeMcpClient {
  readonly calls: RecordedCall[] = [];
  #responses: ToolCallResult[];

  constructor(responses: ToolCallResult[] = []) {
    this.#responses = [...responses];
  }

  callTool(name: string, params: Record<string, unknown>): Promise<ToolCallResult> {
    this.calls.push({ name, params });
    return Promise.resolve(this.#responses.shift() ?? ok({ summary: "ok" }));
  }
}

function ok(value: unknown): ToolCallResult {
  return {
    ok: true,
    content: [{ type: "text", text: JSON.stringify({ result: value }) }],
  };
}

function rawOk(value: unknown): ToolCallResult {
  return {
    ok: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function fakeClient(responses: ToolCallResult[] = []): MCPClient {
  return new FakeMcpClient(responses) as unknown as MCPClient;
}

describe("Den pool member source", () => {
  it("loads configured concrete pool members from crew config", () => {
    const config = CrewConfigSchema.parse({
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      workerPool: {
        members: [
          {
            workerIdentity: "pi-crew-coder-1",
            profileIdentity: "pi-crew-coder-worker",
            role: "coder",
            displayName: "Pi Crew coder lane 1",
            capabilities: ["typescript", "den"],
          },
        ],
      },
    });

    expect(config.workerPool.members).toEqual([
      {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
        displayName: "Pi Crew coder lane 1",
        capabilities: ["typescript", "den"],
      },
    ]);
  });

  it("registers configured ready concrete pool members with Den", async () => {
    const client = fakeClient();
    const reconciler = createDenPoolMemberReconciler({
      mcpClient: client,
      assignedBy: "pi-crew",
      members: [
        {
          workerIdentity: "pi-crew-coder-1",
          profileIdentity: "pi-crew-coder-worker",
          role: "coder",
          displayName: "Pi Crew coder lane 1",
          capabilities: ["typescript", "den"],
          readiness: {
            profileReady: true,
            modelReady: true,
            mcpReady: true,
            completionReady: true,
          },
        },
      ],
    });

    const result = await reconciler.reconcile();

    expect(result.registered).toEqual(["pi-crew-coder-1"]);
    expect(result.degraded).toEqual([]);
    const recorded = (client as unknown as FakeMcpClient).calls;
    expect(recorded).toEqual([
      {
        name: "upsert_pool_member",
        params: {
          worker_identity: "pi-crew-coder-1",
          profile_identity: "pi-crew-coder-worker",
          worker_role: "coder",
          display_name: "Pi Crew coder lane 1",
          capabilities: '["typescript","den"]',
          status: "available",
        },
      },
    ]);
  });

  it("registers group-expanded members with selector-safe metadata", async () => {
    const client = fakeClient();
    const config = CrewConfigSchema.parse({
      install: { root: "/home/agents/pi-crew" },
      den: { coreUrl: "http://localhost:3030", requiredAtStartup: false },
      workerPool: {
        groups: [
          {
            groupId: "pi-crew-reviewer",
            role: "reviewer",
            profileIdentity: "pi-crew-reviewer-worker",
            profileId: "reviewer-worker",
            desiredSize: 1,
            identityTemplate: "pi-crew-reviewer-{n}",
            capabilities: ["review", "den", "git"],
            labels: { owner: "pi-crew", pool_group: "pi-crew-reviewer" },
          },
        ],
      },
    });
    const members = resolveWorkerPoolMembers(config);

    await createDenPoolMemberReconciler({
      mcpClient: client,
      assignedBy: "pi-crew",
      members,
    }).reconcile();

    const recorded = (client as unknown as FakeMcpClient).calls;
    expect(recorded[0]?.params["metadata"]).toBe(
      JSON.stringify({
        install_root: "/home/agents/pi-crew",
        profile_id: "reviewer-worker",
        execution_mode: "llmAgent",
        pool_group: "pi-crew-reviewer",
        group_id: "pi-crew-reviewer",
        desired_size: 1,
        lane_index: 1,
        identity_template: "pi-crew-reviewer-{n}",
        owner: "pi-crew",
        labels: { owner: "pi-crew", pool_group: "pi-crew-reviewer" },
      }),
    );
  });

  it("does not register degraded members that lack profile/model/mcp/completion readiness", async () => {
    const client = fakeClient();
    const reconciler = createDenPoolMemberReconciler({
      mcpClient: client,
      assignedBy: "pi-crew",
      members: [
        {
          workerIdentity: "pi-crew-reviewer-1",
          profileIdentity: "pi-crew-reviewer-worker",
          role: "reviewer",
          readiness: {
            profileReady: true,
            modelReady: false,
            mcpReady: true,
            completionReady: true,
          },
        },
      ],
    });

    const result = await reconciler.reconcile();

    expect(result.registered).toEqual([]);
    expect(result.degraded).toEqual([
      {
        workerIdentity: "pi-crew-reviewer-1",
        reason: "model config is not ready",
      },
    ]);
    expect((client as unknown as FakeMcpClient).calls).toEqual([]);
  });

  it("reports no assignment without claiming local queued work when Den has no capacity", async () => {
    const client = fakeClient([
      ok({
        reason_code: "no_matching_worker",
        diagnostic: "No matching worker is leased.",
      }),
    ]);
    const consumer = createDenPoolAssignmentConsumer({
      mcpClient: client,
      member: {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
      },
    });

    const result = await consumer.consumeNextAssignment();

    expect(result).toEqual({
      status: "no_assignment",
      reason: "no_matching_worker",
      diagnostic: "No matching worker is leased.",
    });
    expect((client as unknown as FakeMcpClient).calls).toEqual([
      {
        name: "list_assignments",
        params: { worker_identity: "pi-crew-coder-1", state: "ack", limit: 1, verbose: true },
      },
    ]);
  });

  it("reports no assignment when Den returns an empty assignment list", async () => {
    const client = fakeClient([
      rawOk({ summary: "listed 0 assignment(s)", count: 0, assignments: [] }),
    ]);
    const consumer = createDenPoolAssignmentConsumer({
      mcpClient: client,
      member: {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
      },
    });

    await expect(consumer.consumeNextAssignment()).resolves.toEqual({
      status: "no_assignment",
      reason: "none_available",
      diagnostic: "No ack assignment envelope is available for pi-crew-coder-1.",
    });
  });

  it("builds a WorkerBinding from an authoritative Den assignment envelope", async () => {
    const client = fakeClient([
      rawOk({
        summary: "listed 1 assignment(s)",
        count: 1,
        assignments: [
          {
            id: 1127,
            state: "ack",
            project_id: "pi-crew",
            task_id: 2181,
            run_id: "piw_2181_live_coder_1",
            role: "coder",
            worker_identity: "pi-crew-coder-1",
          },
        ],
      }),
    ]);
    const consumer = createDenPoolAssignmentConsumer({
      mcpClient: client,
      member: {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
      },
    });

    const result = await consumer.consumeNextAssignment();

    expect(result).toEqual({
      status: "assignment",
      binding: {
        assignmentId: "1127",
        runId: "piw_2181_live_coder_1",
        taskId: "2181",
        projectId: "pi-crew",
        role: "coder",
      },
      readback: {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
        assignmentId: "1127",
        runId: "piw_2181_live_coder_1",
        taskId: "2181",
        projectId: "pi-crew",
      },
    });
  });

  it("fails closed on assignment envelopes for quarantined or mismatched workers", async () => {
    const client = fakeClient([
      rawOk({
        summary: "listed 1 assignment(s)",
        count: 1,
        assignments: [
          {
            id: 1128,
            state: "quarantined",
            project_id: "pi-crew",
            task_id: 2181,
            run_id: "piw_2181_bad",
            role: "coder",
            worker_identity: "pi-crew-coder-2",
          },
        ],
      }),
    ]);
    const consumer = createDenPoolAssignmentConsumer({
      mcpClient: client,
      member: {
        workerIdentity: "pi-crew-coder-1",
        profileIdentity: "pi-crew-coder-worker",
        role: "coder",
      },
    });

    await expect(consumer.consumeNextAssignment()).rejects.toBeInstanceOf(
      DenPoolSourceConfigurationError,
    );
  });
});
