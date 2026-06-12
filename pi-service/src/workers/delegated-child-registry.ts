/** Durable pending-child registry for delegated sessions. */

import type {
  DelegatedResult,
  DelegationLineage,
  DelegationOrphanDetectedPayload,
  EffectiveDelegationRuntime,
  EventBus,
  Logger,
} from "@pi-crew/core";

export type PendingChildStatus = "active" | "completed" | "failed" | "killed" | "timed_out" | "orphaned";

export interface PendingChildRecord {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly rootSessionId: string;
  readonly lineage: DelegationLineage;
  readonly status: PendingChildStatus;
  readonly spawnedAt: string;
  readonly updatedAt: string;
  readonly timeoutMs?: number;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly latestEventId?: string;
  readonly latestCheckpointId?: string;
  readonly outcome?: DelegatedResult["outcome"];
}

export interface PendingChildRepository {
  upsert(record: PendingChildRecord): Promise<void>;
  get(childSessionId: string): Promise<PendingChildRecord | null>;
  listActive(): Promise<readonly PendingChildRecord[]>;
  listAll(): Promise<readonly PendingChildRecord[]>;
  deleteOlderThan(cutoffIso: string): Promise<number>;
}

export interface RegistrySpawnInput {
  readonly lineage: DelegationLineage;
  readonly policyId: string;
  readonly effectiveRuntime: EffectiveDelegationRuntime;
  readonly timeoutMs?: number;
  readonly eventId?: string;
  readonly checkpointId?: string;
  readonly now?: Date;
}

export interface RegistryRecoverInput {
  readonly now?: Date;
  readonly activeChildSessionIds?: readonly string[];
}

export interface RegistryRecoveryResult {
  readonly running: readonly PendingChildRecord[];
  readonly orphaned: readonly PendingChildRecord[];
  readonly timedOut: readonly PendingChildRecord[];
}

export interface DelegatedChildRegistryConfig {
  readonly repository: PendingChildRepository;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly ttlMs?: number;
}

export class DelegatedChildRegistry {
  readonly #repository: PendingChildRepository;
  readonly #eventBus: EventBus;
  readonly #logger: Logger;
  readonly #ttlMs: number;

  constructor(config: DelegatedChildRegistryConfig) {
    this.#repository = config.repository;
    this.#eventBus = config.eventBus;
    this.#logger = config.logger;
    this.#ttlMs = config.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  async recordSpawned(input: RegistrySpawnInput): Promise<void> {
    const now = (input.now ?? new Date()).toISOString();
    await this.#repository.upsert({
      childSessionId: input.lineage.childSessionId,
      parentSessionId: input.lineage.parentSessionId,
      rootSessionId: input.lineage.rootSessionId,
      lineage: input.lineage,
      status: "active",
      spawnedAt: now,
      updatedAt: now,
      timeoutMs: input.timeoutMs,
      policyId: input.policyId,
      effectiveRuntime: input.effectiveRuntime,
      latestEventId: input.eventId,
      latestCheckpointId: input.checkpointId,
    });
  }

  async recordCompleted(result: DelegatedResult, now: Date = new Date()): Promise<void> {
    await this.transition(result.childSessionId, statusForOutcome(result.outcome), now, result.outcome);
  }

  async recordKilled(childSessionId: string, now: Date = new Date()): Promise<void> {
    await this.transition(childSessionId, "killed", now, "killed");
  }

  async recoverPending(input: RegistryRecoverInput = {}): Promise<RegistryRecoveryResult> {
    const now = input.now ?? new Date();
    const active = new Set(input.activeChildSessionIds ?? []);
    const running: PendingChildRecord[] = [];
    const orphaned: PendingChildRecord[] = [];
    const timedOut: PendingChildRecord[] = [];

    for (const record of await this.#repository.listActive()) {
      if (active.has(record.childSessionId)) {
        running.push(record);
        continue;
      }
      if (record.timeoutMs !== undefined && elapsedMs(record.spawnedAt, now) >= record.timeoutMs) {
        const next = await this.transition(record.childSessionId, "timed_out", now, "timeout");
        timedOut.push(next ?? record);
        continue;
      }
      const next = await this.transition(record.childSessionId, "orphaned", now, "orphaned");
      const orphan = next ?? record;
      orphaned.push(orphan);
      this.emitOrphan(orphan, now);
    }

    return { running, orphaned, timedOut };
  }

  async cleanupExpired(now: Date = new Date()): Promise<number> {
    return this.#repository.deleteOlderThan(new Date(now.getTime() - this.#ttlMs).toISOString());
  }

  async transition(
    childSessionId: string,
    status: PendingChildStatus,
    now: Date,
    outcome?: DelegatedResult["outcome"],
  ): Promise<PendingChildRecord | null> {
    const existing = await this.#repository.get(childSessionId);
    if (existing === null) {
      this.#logger.warn("Delegated child registry transition missing record", { childSessionId, status });
      return null;
    }
    const next = { ...existing, status, updatedAt: now.toISOString(), outcome };
    await this.#repository.upsert(next);
    return next;
  }

  private emitOrphan(record: PendingChildRecord, now: Date): void {
    const payload: DelegationOrphanDetectedPayload = {
      orphanSessionId: record.childSessionId,
      lastKnownParentSessionId: record.parentSessionId,
      idleDurationMs: elapsedMs(record.updatedAt, now),
      lineage: record.lineage,
      policyId: record.policyId,
      profileId: record.effectiveRuntime.profileId,
    };
    this.#eventBus.emit({ event: "delegation.orphan_detected", payload });
  }
}

export class InMemoryPendingChildRepository implements PendingChildRepository {
  readonly #records = new Map<string, PendingChildRecord>();

  upsert(record: PendingChildRecord): Promise<void> {
    this.#records.set(record.childSessionId, { ...record });
    return Promise.resolve();
  }

  get(childSessionId: string): Promise<PendingChildRecord | null> {
    const record = this.#records.get(childSessionId);
    return Promise.resolve(record === undefined ? null : { ...record });
  }

  listActive(): Promise<readonly PendingChildRecord[]> {
    return Promise.resolve(this.records().filter((record) => record.status === "active"));
  }

  listAll(): Promise<readonly PendingChildRecord[]> {
    return Promise.resolve(this.records());
  }

  deleteOlderThan(cutoffIso: string): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.#records.entries()) {
      if (record.updatedAt < cutoffIso) {
        this.#records.delete(id);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  private records(): PendingChildRecord[] {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }
}

function statusForOutcome(outcome: DelegatedResult["outcome"]): PendingChildStatus {
  if (outcome === "success") return "completed";
  if (outcome === "failure") return "failed";
  if (outcome === "timeout") return "timed_out";
  if (outcome === "killed") return "killed";
  return "orphaned";
}

function elapsedMs(sinceIso: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(sinceIso));
}
