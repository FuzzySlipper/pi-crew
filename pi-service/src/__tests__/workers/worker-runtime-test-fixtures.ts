/** Test fixtures for WorkerRuntime tests. */

import type { CompletionPacket, CompletionPostResult } from "@pi-crew/core";
import type { CompletionPoster } from "@pi-crew/tools";
import type {
  WorkerExecutor,
  WorkerExecutionContext,
  WorkerExecutionResult,
} from "../../workers/worker-runtime.js";
import type {
  WorkerRoleBinding,
  WorkerRoleMappingConfig,
} from "../../workers/worker-role-config.js";
import type { WorkerBinding, SessionConfig, SessionRecord } from "../../sessions/types.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import type { AgentInstance } from "../../instances/agent-instance.js";
import type { AuditRepository, AuditRow } from "../../persistence/types.js";

const DEFAULT_WORKER_BINDINGS: WorkerRoleBinding[] = [
  { role: "packet-auditor", profileId: "packet-auditor-worker" },
  { role: "packet_auditor", profileId: "packet-auditor-worker" },
  { role: "coder", profileId: "coder-worker" },
  { role: "reviewer", profileId: "reviewer-worker" },
  { role: "validator", profileId: "validator-worker" },
  { role: "drift_checker", profileId: "drift-checker-worker" },
];

export class FakeSessionManager implements SessionManager {
  private nextId = 1;
  readonly archived: string[] = [];
  readonly created: SessionRecord[] = [];
  readonly sessionStore = new Map<string, SessionRecord>();

  create(config: SessionConfig): Promise<SessionRecord> {
    const id = `session-${String(this.nextId++)}`;
    const record: SessionRecord = {
      id,
      profileId: config.profileId,
      instanceId: null,
      kind: config.kind,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      state: "active",
      messageCount: 0,
      channelBindings: config.channelBindings ?? [],
      workerBinding: config.workerBinding ?? null,
      delegation: config.delegation ?? null,
      delegationSpawnRequest: config.delegationSpawnRequest ?? null,
    };
    this.sessionStore.set(id, record);
    this.created.push(record);
    return Promise.resolve(record);
  }

  archive(sessionId: string): Promise<void> {
    this.archived.push(sessionId);
    const existing = this.sessionStore.get(sessionId);
    if (existing) {
      this.sessionStore.set(sessionId, {
        ...existing,
        instanceId: null,
        state: "archived",
        lastActiveAt: new Date().toISOString(),
      });
    }
    return Promise.resolve();
  }

  get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.sessionStore.get(sessionId);
    return Promise.resolve(record && record.state !== "archived" ? record : null);
  }

  findByChannel(channelId: string): Promise<SessionRecord | null> {
    void channelId;
    return Promise.resolve(null);
  }

  bindChannel(sessionId: string, channelId: string): Promise<void> {
    void sessionId;
    void channelId;
    return Promise.resolve();
  }

  unbindChannel(sessionId: string, channelId: string): Promise<void> {
    void sessionId;
    void channelId;
    return Promise.resolve();
  }

  async routeMessage(provider: unknown, message: unknown): Promise<void> {
    void provider;
    void message;
    await Promise.resolve();
  }

  evictIdle(maxSessions?: number): Promise<number> {
    void maxSessions;
    return Promise.resolve(0);
  }

  evictIdleSessions(): Promise<number> {
    return Promise.resolve(0);
  }
}

export class FakeAuditRepo implements AuditRepository {
  readonly events: Array<{
    readonly sessionId?: string;
    readonly assignmentId?: string;
    readonly runId?: string;
    readonly eventType: string;
    readonly eventData: Record<string, unknown>;
  }> = [];

  write(input: {
    sessionId?: string;
    assignmentId?: string;
    runId?: string;
    eventType: string;
    eventData: Record<string, unknown>;
  }): Promise<number> {
    this.events.push({
      sessionId: input.sessionId,
      assignmentId: input.assignmentId,
      runId: input.runId,
      eventType: input.eventType,
      eventData: input.eventData,
    });
    return Promise.resolve(this.events.length - 1);
  }

  getPending(limit?: number): Promise<AuditRow[]> {
    void limit;
    return Promise.resolve([]);
  }

  markFlushed(ids: number[]): Promise<void> {
    void ids;
    return Promise.resolve();
  }

  pruneOlderThan(cutoff: string): Promise<number> {
    void cutoff;
    return Promise.resolve(0);
  }
}

export function makeFakePool(): InstancePool {
  return {
    acquire(profileId: string, role?: string): Promise<AgentInstance> {
      void profileId;
      void role;
      return Promise.reject(new Error("pool not used in timeout tests"));
    },
    release(instanceId: string): Promise<void> {
      void instanceId;
      return Promise.resolve();
    },
    evictIdle(): Promise<number> {
      return Promise.resolve(0);
    },
    get size(): number {
      return 0;
    },
    touch(instanceId: string): void {
      void instanceId;
    },
    has(instanceId: string): boolean {
      void instanceId;
      return false;
    },
    get(instanceId: string): AgentInstance | undefined {
      void instanceId;
      return undefined;
    },
  };
}

export function makeBinding(overrides?: Partial<WorkerBinding>): WorkerBinding {
  return {
    assignmentId: "101",
    runId: "piw_test_run",
    taskId: "2066",
    projectId: "pi-crew",
    role: "coder",
    ...overrides,
  };
}

export function makeRoleMapping(): WorkerRoleMappingConfig {
  return { bindings: [...DEFAULT_WORKER_BINDINGS] };
}

export function makeTimeoutRoleMapping(timeoutMs: number): WorkerRoleMappingConfig {
  return makePolicyRoleMapping({ assignmentTimeoutMs: timeoutMs });
}

export function makeIdleRoleMapping(
  idleTimeoutMs: number,
  assignmentTimeoutMs = 30_000,
): WorkerRoleMappingConfig {
  return makePolicyRoleMapping({ assignmentTimeoutMs, idleTimeoutMs });
}

function makePolicyRoleMapping(policy: {
  readonly assignmentTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}): WorkerRoleMappingConfig {
  return {
    bindings: DEFAULT_WORKER_BINDINGS.map((binding) =>
      binding.role === "coder"
        ? {
            ...binding,
            config: {
              toolPolicyDefaults: policy,
            },
          }
        : binding,
    ),
  };
}

export function makeFastExecutor(result?: Partial<WorkerExecutionResult>): WorkerExecutor {
  return {
    execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
      void context;
      return Promise.resolve({
        status: "completed",
        artifacts: [{ type: "test", ref: "r", summary: "fast executor" }],
        filesTouched: ["test.ts"],
        toolsUsed: ["test-tool"],
        tokensConsumed: 100,
        summary: "done",
        ...result,
      });
    },
  };
}

export function makeSlowExecutor(delayMs: number): WorkerExecutor {
  return {
    async execute(context: WorkerExecutionContext): Promise<WorkerExecutionResult> {
      void context;
      await sleep(delayMs);
      return {
        status: "completed",
        artifacts: [
          {
            type: "test",
            ref: "r",
            summary: `slow executor (${String(delayMs)}ms)`,
          },
        ],
        filesTouched: ["test.ts"],
        toolsUsed: ["test-tool"],
        tokensConsumed: 100,
        summary: "done",
      };
    },
  };
}

export function makeAcceptingPoster(): CompletionPoster {
  return (packet: CompletionPacket): Promise<CompletionPostResult> => {
    void packet;
    return Promise.resolve({ accepted: true, message: "accepted" });
  };
}

export function makeRejectingPoster(errorMsg?: string): CompletionPoster {
  return (packet: CompletionPacket): Promise<CompletionPostResult> => {
    void packet;
    return Promise.reject(new Error(errorMsg ?? "Den unavailable"));
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}
