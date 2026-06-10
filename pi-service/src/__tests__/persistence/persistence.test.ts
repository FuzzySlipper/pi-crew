import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import type { DelegationConstraints, EffectiveDelegationRuntime, Logger } from "@pi-crew/core";
import { RuntimeDb } from "../../persistence/runtime-db.js";
import { SqliteSessionRepository } from "../../persistence/session-repository.js";
import { SqliteMessageRepository } from "../../persistence/message-repository.js";
import { SqliteAuditRepository } from "../../persistence/audit-repository.js";
import { StartupHydrator } from "../../persistence/startup-hydration.js";
import type { DatabaseConfig } from "../../config.js";
import type { ChannelBindingRecord, SessionRecord, WorkerBinding } from "../../sessions/types.js";
import type { DenAssignmentReader, DenAssignmentStatus } from "../../persistence/types.js";

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const dbPath = (name: string): string => `/tmp/pi-crew-test/test-${name}-${String(Date.now())}.db`;
const config = (path: string): DatabaseConfig => ({ path, wal: true });

function present<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  return value as T;
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "session-1",
    kind: "conversational",
    profileId: "runner",
    instanceId: null,
    createdAt: now,
    lastActiveAt: now,
    state: "active",
    messageCount: 0,
    channelBindings: [],
    workerBinding: null,
    delegation: null,
    delegationSpawnRequest: null,
    ...overrides,
  };
}

const delegatedRuntime: EffectiveDelegationRuntime = {
  profileId: "spawned-coder",
  provider: "local-openai",
  model: "qwen-coder",
};

const delegatedConstraints: DelegationConstraints = {
  maxSpawnDepth: 2,
  maxConcurrentChildren: 1,
};

function binding(overrides: Partial<WorkerBinding> = {}): WorkerBinding {
  return {
    assignmentId: "assignment-1",
    runId: "run-1",
    taskId: "1866",
    projectId: "pi-crew",
    role: "coder",
    ...overrides,
  };
}

function channelBinding(overrides: Partial<ChannelBindingRecord> = {}): ChannelBindingRecord {
  return {
    providerId: "den-channels",
    channelId: "642",
    memberIdentity: "pi-crew-runner",
    profileIdentity: "pi-crew-runner",
    memberRole: "runner",
    subscriptionIdentity: "pi-crew-runner:ordinary:sess-1",
    sessionOwnerId: "owner:den-k8plus:pi-crew-runner",
    ...overrides,
  };
}

class StubDenReader implements DenAssignmentReader {
  constructor(private readonly statuses: DenAssignmentStatus[]) {}

  checkAssignments(ids: string[]): Promise<DenAssignmentStatus[]> {
    return Promise.resolve(
      ids.map(
        (id) =>
          this.statuses.find((status) => status.assignmentId === id) ?? {
            assignmentId: id,
            isActive: true,
          },
      ),
    );
  }
}

describe("runtime persistence", () => {
  let path: string;
  let db: RuntimeDb;

  beforeEach(() => {
    path = dbPath("runtime");
    db = new RuntimeDb(config(path), logger);
  });

  afterEach(() => {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  });

  it("opens SQLite in WAL mode and creates only runtime tables", () => {
    const health = db.health();
    expect(health.walEnabled).toBe(true);
    expect(health.schemaVersion).toBe(4);
    const rows = db.handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    expect(names).toContain("sessions");
    expect(names).toContain("messages");
    expect(names).toContain("audit_log");
    expect(names).toContain("runtime_kv");
    expect(names).not.toContain("blackboard");
    expect(names).not.toContain("memory");
  });

  it("persists conversational and worker sessions across reopen", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(
      session({ id: "chat", channelBindings: ["den:604"], instanceId: "inst-chat" }),
    );
    await sessions.save(
      session({ id: "worker", kind: "worker", channelBindings: [], workerBinding: binding() }),
    );
    db.close();

    db = new RuntimeDb(config(path), logger);
    const reopened = new SqliteSessionRepository(db.handle, logger);
    const chat = present(await reopened.findByChannel("den:604"));
    expect(chat.id).toBe("chat");
    expect(chat.instanceId).toBe("inst-chat");
    expect(present(await reopened.get("worker")).workerBinding?.runId).toBe("run-1");
  });

  it("persists delegated runtime and remaining delegation constraints across reopen", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(
      session({
        id: "delegated-child",
        kind: "delegated",
        profileId: "spawned-coder",
        delegation: {
          parentSessionId: "parent-session",
          rootSessionId: "root-session",
          childSessionId: "delegated-child",
          depth: 1,
          chain: ["root-session", "delegated-child"],
        },
        delegationSpawnRequest: {
          task: "check a delegated subtask",
          modelSelection: { provider: "local-openai", model: "qwen-coder" },
        },
        delegationConstraints: delegatedConstraints,
        effectiveRuntime: delegatedRuntime,
      }),
    );
    db.close();

    db = new RuntimeDb(config(path), logger);
    const reopened = new SqliteSessionRepository(db.handle, logger);
    const record = present(await reopened.get("delegated-child"));

    expect(record.delegationConstraints).toEqual(delegatedConstraints);
    expect(record.effectiveRuntime).toEqual(delegatedRuntime);
  });

  it("persists typed channel bindings and finds them by channel", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session({ id: "typed-chat", channelBindings: [channelBinding()] }));

    const found = present(await sessions.findByChannel("642"));
    const reopened = present(await sessions.get("typed-chat"));

    expect(found.id).toBe("typed-chat");
    expect(reopened.channelBindings[0]).toMatchObject({
      channelId: "642",
      memberIdentity: "pi-crew-runner",
      subscriptionIdentity: "pi-crew-runner:ordinary:sess-1",
    });
  });

  it("finds exact typed channel bindings after LIKE false positives", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(
      session({ id: "false-positive", channelBindings: [channelBinding({ channelId: "x642" })] }),
    );
    await sessions.save(
      session({ id: "exact-match", channelBindings: [channelBinding({ channelId: "642" })] }),
    );

    expect(present(await sessions.findByChannel("642")).id).toBe("exact-match");
  });

  it("finds typed channel bindings whose IDs contain LIKE wildcards", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(
      session({
        id: "underscore-channel",
        channelBindings: [channelBinding({ channelId: "ch_alpha" })],
      }),
    );

    expect(present(await sessions.findByChannel("ch_alpha")).id).toBe("underscore-channel");
  });

  it("persists messages with token counts per session", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session({ id: "chat" }));
    const messages = new SqliteMessageRepository(db.handle);
    await messages.append({ sessionId: "chat", role: "user", content: "hello", tokenCount: 2 });
    await messages.append({ sessionId: "chat", role: "assistant", content: "hi", tokenCount: 1 });
    expect(await messages.count("chat")).toBe(2);
    expect((await messages.getBySession("chat")).at(0)?.token_count).toBe(2);
  });

  it("redacts audit data while preserving Den correlations", async () => {
    const audit = new SqliteAuditRepository(db.handle);
    await audit.write({
      eventType: "tool.called",
      assignmentId: "assignment-42",
      runId: "run-42",
      eventData: { api_key: "example-secret", command: "Authorization: Bearer local-token" },
    });
    const row = present((await audit.getPending()).at(0));
    const data = JSON.parse(row.event_data) as Record<string, unknown>;
    expect(data["api_key"]).toBe("[REDACTED]");
    expect(String(data["command"])).toContain("[REDACTED]");
    expect(row.assignment_id).toBe("assignment-42");
    expect(row.run_id).toBe("run-42");
    await audit.markFlushed([row.id]);
    expect(await audit.getPending()).toHaveLength(0);
  });

  it("hydrates active sessions and archives terminal worker bindings", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session({ id: "chat", kind: "conversational" }));
    await sessions.save(
      session({
        id: "done-worker",
        kind: "worker",
        channelBindings: [],
        workerBinding: binding({ assignmentId: "done" }),
      }),
    );
    const hydrator = new StartupHydrator(
      sessions,
      new StubDenReader([{ assignmentId: "done", isActive: false }]),
      logger,
    );
    const result = await hydrator.hydrate();
    expect(result.activeSessions).toBe(2);
    expect(result.archivedSessionIds).toContain("done-worker");
    expect(await sessions.get("done-worker")).toBeNull();
  });
});
