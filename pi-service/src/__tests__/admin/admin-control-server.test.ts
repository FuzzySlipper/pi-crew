/** Tests for guarded local admin remediation controls. */
import { describe, expect, it } from "vitest";
import { FakeEventBus } from "@pi-crew/core";

import { AdminServer } from "../../admin/admin-server.js";
import { RemediationControlService } from "../../admin/remediation-control-service.js";
import { loadConfig } from "../../config.js";
import type { DiagnosticsOverview } from "../../diagnostics/types.js";
import { AgentInstanceImpl } from "../../instances/agent-instance.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import type {
  AuditEventInput,
  AuditRow,
  DenAssignmentReader,
} from "../../persistence/types.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { RemediationEvidenceInput } from "../../admin/remediation-control-service.js";

const token = ["control", "admin", "token"].join("-");

describe("AdminServer remediation controls", () => {
  it("requires operator identity, reason, and idempotency key", async () => {
    const fixture = await startControlServer(19400, overviewWithWorkerStale());
    try {
      const response = await controlFetch(fixture.server, "/admin/control/drain", {});
      const body = await responseJson(response);

      expect(response.status).toBe(200);
      expect(body["accepted"]).toBe(false);
      expect(body["warnings"]).toContain("operator is required");
      expect(fixture.audit.rows).toHaveLength(1);
    } finally {
      await fixture.server.stop();
    }
  });

  it("supports dry-run drain idempotently without mutating Den workflow", async () => {
    const fixture = await startControlServer(19401, overviewWithWorkerStale());
    const request = controlRequest("op-drain", true);
    try {
      const first = await responseJson(await controlFetch(fixture.server, "/admin/control/drain", request));
      const second = await responseJson(await controlFetch(fixture.server, "/admin/control/drain", request));

      expect(first["accepted"]).toBe(true);
      expect(first["dryRun"]).toBe(true);
      expect(readPath(first, ["after", "drainMode"])).toBe("inactive");
      expect(readPath(first, ["denEvidence", "posted"])).toBe(true);
      expect(second["controlId"]).toBe(first["controlId"]);
      expect(fixture.audit.rows).toHaveLength(1);
      expect(fixture.evidencePoster.inputs).toHaveLength(1);
    } finally {
      await fixture.server.stop();
    }
  });

  it("denies worker stale mutation when Den readback is unavailable", async () => {
    const fixture = await startControlServer(
      19402,
      overviewWithWorkerStale({ denCore: { status: "unreachable", lastOkAt: null } }),
    );
    try {
      const response = await controlFetch(
        fixture.server,
        "/admin/control/workers/assignment-1/mark-local-stale",
        controlRequest("op-stale"),
      );
      const body = await responseJson(response);

      expect(body["accepted"]).toBe(false);
      expect(readPath(body, ["denEvidence", "status"])).toBe("den_state_unavailable");
      expect(fixture.denReader.checked).toEqual([]);
      expect(fixture.evidencePoster.inputs).toEqual([]);
    } finally {
      await fixture.server.stop();
    }
  });

  it("accepts mark-local-stale only when local evidence and Den active state agree", async () => {
    const fixture = await startControlServer(19403, overviewWithWorkerStale());
    try {
      const accepted = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/workers/assignment-1/mark-local-stale",
          controlRequest("op-stale-agree"),
        ),
      );
      fixture.denReader.active = false;
      const denied = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/workers/assignment-1/mark-local-stale",
          controlRequest("op-stale-disagree"),
        ),
      );

      expect(accepted["accepted"]).toBe(true);
      expect(readPath(accepted, ["after", "localStale"])).toBe(true);
      expect(denied["accepted"]).toBe(false);
      expect(readPath(denied, ["denEvidence", "status"])).toBe("den_disagrees");
    } finally {
      await fixture.server.stop();
    }
  });

  it("recreates only conversational sessions and preserves worker sovereignty", async () => {
    const fixture = await startControlServer(19404, overviewWithWorkerStale());
    try {
      const workerResponse = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/sessions/worker-session/recreate-instance",
          controlRequest("op-worker-recreate"),
        ),
      );
      const conversationResponse = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/sessions/conversation-session/recreate-instance",
          controlRequest("op-conversation-recreate"),
        ),
      );
      const updated = await fixture.sessionStore.get("conversation-session");

      expect(workerResponse["accepted"]).toBe(false);
      expect(readPath(workerResponse, ["denEvidence", "status"])).toBe("worker_sessions_den_sovereign");
      expect(conversationResponse["accepted"]).toBe(true);
      expect(updated?.channelBindings).toEqual(["channel-1"]);
      expect(updated?.instanceId).toBe("new-instance-1");
      expect(fixture.instancePool.released).toEqual(["old-instance-1"]);
    } finally {
      await fixture.server.stop();
    }
  });

  it("redacts secret-like control response fields", async () => {
    const fixture = await startControlServer(19406, overviewWithWorkerStale());
    try {
      const response = await controlFetch(fixture.server, "/admin/control/drain", {
        operator: "patch",
        reason: "api_key=super-secret-token",
        idempotencyKey: "op-redaction",
      });
      const text = await response.text();

      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("super-secret-token");
    } finally {
      await fixture.server.stop();
    }
  });

  it("validates config without applying and reloads only valid candidates", async () => {
    const fixture = await startControlServer(19405, overviewWithWorkerStale());
    const invalid = { den: { coreUrl: "not-a-url" } };
    const valid = { den: { coreUrl: "http://den-srv:3030", requiredAtStartup: false } };
    try {
      const invalidResponse = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/config/validate",
          controlRequest("op-config-invalid", false, invalid),
        ),
      );
      const reloadResponse = await responseJson(
        await controlFetch(
          fixture.server,
          "/admin/control/config/reload",
          controlRequest("op-config-valid", false, valid),
        ),
      );

      expect(invalidResponse["accepted"]).toBe(false);
      expect(readPath(invalidResponse, ["denEvidence", "status"])).toBe("config_invalid");
      expect(reloadResponse["accepted"]).toBe(true);
      expect(readPath(reloadResponse, ["after", "applied"])).toBe(true);
    } finally {
      await fixture.server.stop();
    }
  });
});

async function startControlServer(port: number, overview: DiagnosticsOverview): Promise<ControlFixture> {
  const audit = new FakeAuditRepository();
  const eventBus = new FakeEventBus();
  const sessionStore = new InMemorySessionStore();
  await seedSessions(sessionStore);
  const instancePool = new FakeInstancePool();
  const denReader = new FakeDenAssignmentReader();
  const evidencePoster = new FakeEvidencePoster();
  const diagnostics = { projectOverview: () => Promise.resolve(overview) };
  const controls = new RemediationControlService({
    diagnostics,
    auditRepository: audit,
    eventBus,
    sessionStore,
    instancePool,
    denAssignmentReader: denReader,
    evidencePoster,
    validateConfig: validateGatewayConfig,
    idFactory: () => `ctrl_${String(audit.rows.length + 1)}`,
  });
  const server = new AdminServer({
    config: { enabled: true, host: "127.0.0.1", port, bearerToken: token, allowLanBind: false },
    diagnostics,
    controls,
  });
  await server.start();
  return { audit, denReader, evidencePoster, instancePool, server, sessionStore };
}

interface ControlFixture {
  readonly audit: FakeAuditRepository;
  readonly denReader: FakeDenAssignmentReader;
  readonly evidencePoster: FakeEvidencePoster;
  readonly instancePool: FakeInstancePool;
  readonly server: AdminServer;
  readonly sessionStore: InMemorySessionStore;
}

function controlFetch(server: AdminServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://${server.host}:${String(server.port)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function controlRequest(idempotencyKey: string, dryRun = false, candidateConfig?: unknown) {
  return { operator: "patch", reason: "test control", idempotencyKey, dryRun, candidateConfig };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("expected object");
}

function readPath(value: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateGatewayConfig(raw: unknown) {
  try {
    loadConfig(raw);
    return { valid: true, errors: [] };
  } catch (error: unknown) {
    return { valid: false, errors: [(error as Error).message] };
  }
}

async function seedSessions(store: InMemorySessionStore): Promise<void> {
  await store.save(sessionRecord("conversation-session", "conversational", "old-instance-1", null, ["channel-1"]));
  await store.save(
    sessionRecord("worker-session", "worker", "worker-instance", {
      assignmentId: "assignment-1",
      runId: "run-1",
      taskId: "2118",
      projectId: "pi-crew",
      role: "coder",
    }),
  );
}

function sessionRecord(
  id: string,
  kind: "conversational" | "worker",
  instanceId: string | null,
  workerBinding: SessionRecord["workerBinding"],
  channelBindings: string[] = [],
): SessionRecord {
  return {
    id,
    profileId: "default",
    instanceId,
    kind,
    delegation: null,
    delegationSpawnRequest: null,
    createdAt: "2026-06-08T05:00:00.000Z",
    lastActiveAt: "2026-06-08T05:00:00.000Z",
    state: "active",
    messageCount: 1,
    channelBindings,
    workerBinding,
  };
}

function overviewWithWorkerStale(overrides: Partial<DiagnosticsOverview> = {}): DiagnosticsOverview {
  return {
    service: { status: "ok", version: "test", uptimeSeconds: 1, startedAt: "now", drainMode: "inactive" },
    classification: { kind: "pi_crew_local", summary: "worker stale" },
    denCore: { status: "ok", lastOkAt: "now" },
    denChannels: { status: "ok", lastOkAt: "now" },
    mcp: { status: "ok", lastOkAt: "now" },
    runtimeDb: { status: "ok", path: "/tmp/db", walEnabled: true, tableCount: 4, schemaVersion: 1 },
    counts: {
      activeSessions: 1,
      workerSessions: 1,
      conversationalSessions: 0,
      activeAssignmentsLocal: 1,
      stuckWorkers: 1,
      checkpointWaiting: 0,
    },
    sessions: [
      {
        sessionId: "worker-session",
        profileId: "default",
        instanceId: "worker-instance",
        kind: "worker",
        sessionState: "active",
        messageCount: 1,
        channelBindings: [],
        workerBinding: {
          assignmentId: "assignment-1",
          runId: "run-1",
          taskId: "2118",
          projectId: "pi-crew",
          role: "coder",
        },
        denAssignment: { assignmentId: "assignment-1", isActive: true },
        localLifecycleState: "worker.stuck",
        lastActivityAt: "now",
        lastGatewayEvent: "worker.stuck",
        contextPressure: null,
        drainState: "inactive",
        classification: "pi_crew_local",
        evidenceRefs: ["worker.stuck:assignment-1"],
      },
    ],
    recentEvents: [],
    ...overrides,
  };
}

class FakeAuditRepository {
  readonly rows: AuditEventInput[] = [];

  write(input: AuditEventInput): Promise<number> {
    this.rows.push(input);
    return Promise.resolve(this.rows.length);
  }

  getPending(): Promise<AuditRow[]> {
    return Promise.resolve([]);
  }

  markFlushed(): Promise<void> {
    return Promise.resolve();
  }

  pruneOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }
}

class FakeDenAssignmentReader implements DenAssignmentReader {
  active = true;
  readonly checked: string[][] = [];

  checkAssignments(ids: string[]) {
    this.checked.push(ids);
    return Promise.resolve(ids.map((assignmentId) => ({ assignmentId, isActive: this.active })));
  }
}

class FakeEvidencePoster {
  readonly inputs: RemediationEvidenceInput[] = [];

  postEvidence(input: RemediationEvidenceInput) {
    this.inputs.push(input);
    return Promise.resolve({ posted: true, messageId: null, notificationId: this.inputs.length });
  }
}

class FakeInstancePool implements InstancePool {
  readonly released: string[] = [];
  size = 0;

  acquire(profileId: string) {
    void profileId;
    return Promise.resolve(new AgentInstanceImpl("default", undefined, "new-instance-1"));
  }

  release(instanceId: string): Promise<void> {
    this.released.push(instanceId);
    return Promise.resolve();
  }

  evictIdle(): Promise<number> {
    return Promise.resolve(0);
  }

  touch(): void {}

  has(): boolean {
    return false;
  }

  get(): undefined {
    return undefined;
  }
}
