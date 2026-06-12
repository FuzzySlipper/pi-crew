/** Tests for delegated pending-child registry and restart recovery. */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FakeEventBus, FakeLogger, type DelegationLineage, type EffectiveDelegationRuntime } from "@pi-crew/core";
import { RuntimeDb, SqlitePendingChildRepository } from "../../persistence/index.js";
import {
  DelegatedChildRegistry,
  InMemoryPendingChildRepository,
  type PendingChildRepository,
} from "../../workers/delegated-child-registry.js";

const runtime: EffectiveDelegationRuntime = { profileId: "child-profile", provider: "local", model: "small" };
const lineage: DelegationLineage = {
  parentSessionId: "parent-session",
  rootSessionId: "root-session",
  childSessionId: "child-session-1",
  depth: 1,
  chain: ["root-session", "child-session-1"],
};

describe("DelegatedChildRegistry", () => {
  it("records spawn and terminal transitions", async () => {
    const repository = new InMemoryPendingChildRepository();
    const registry = createRegistry(repository);
    await registry.recordSpawned({
      lineage,
      policyId: "delegated-child-session-1",
      effectiveRuntime: runtime,
      timeoutMs: 1_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const active = await repository.get("child-session-1");
    expect(active?.status).toBe("active");
    expect(active?.rootSessionId).toBe("root-session");
    expect(active?.timeoutMs).toBe(1_000);

    await registry.recordCompleted({
      outcome: "success",
      summary: "done",
      policyId: "delegated-child-session-1",
      childSessionId: "child-session-1",
    }, new Date("2026-01-01T00:00:02.000Z"));

    const completed = await repository.get("child-session-1");
    expect(completed?.status).toBe("completed");
    expect(completed?.outcome).toBe("success");
  });

  it("classifies missing active children as orphaned and emits an observation event", async () => {
    const eventBus = new FakeEventBus();
    const repository = new InMemoryPendingChildRepository();
    const registry = createRegistry(repository, eventBus);
    await registry.recordSpawned({
      lineage,
      policyId: "delegated-child-session-1",
      effectiveRuntime: runtime,
      timeoutMs: 60_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const recovery = await registry.recoverPending({
      now: new Date("2026-01-01T00:00:10.000Z"),
      activeChildSessionIds: [],
    });

    expect(recovery.orphaned.map((record) => record.childSessionId)).toEqual(["child-session-1"]);
    expect((await repository.get("child-session-1"))?.status).toBe("orphaned");
    expect(eventBus.emitted.map((event) => event.event)).toEqual(["delegation.orphan_detected"]);
    expect(eventBus.emitted[0]?.payload).toMatchObject({
      orphanSessionId: "child-session-1",
      lastKnownParentSessionId: "parent-session",
      policyId: "delegated-child-session-1",
    });
  });

  it("classifies active known children as running and expired children as timed out", async () => {
    const repository = new InMemoryPendingChildRepository();
    const registry = createRegistry(repository);
    await registry.recordSpawned({
      lineage,
      policyId: "policy-running",
      effectiveRuntime: runtime,
      timeoutMs: 100,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await registry.recordSpawned({
      lineage: { ...lineage, childSessionId: "child-session-2", chain: ["root-session", "child-session-2"] },
      policyId: "policy-timeout",
      effectiveRuntime: runtime,
      timeoutMs: 100,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const recovery = await registry.recoverPending({
      now: new Date("2026-01-01T00:00:01.000Z"),
      activeChildSessionIds: ["child-session-1"],
    });

    expect(recovery.running.map((record) => record.childSessionId)).toEqual(["child-session-1"]);
    expect(recovery.timedOut.map((record) => record.childSessionId)).toEqual(["child-session-2"]);
    expect((await repository.get("child-session-2"))?.status).toBe("timed_out");
  });

  it("cleans old registry records by TTL", async () => {
    const repository = new InMemoryPendingChildRepository();
    const registry = createRegistry(repository);
    await registry.recordSpawned({ lineage, policyId: "policy-old", effectiveRuntime: runtime, now: new Date("2026-01-01T00:00:00.000Z") });
    await registry.recordCompleted({ outcome: "success", summary: "done", policyId: "policy-old", childSessionId: "child-session-1" }, new Date("2026-01-01T00:00:00.000Z"));

    expect(await registry.cleanupExpired(new Date("2026-01-09T00:00:00.000Z"))).toBe(1);
    expect(await repository.listAll()).toEqual([]);
  });

  it("persists pending children through SQLite reload", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "pi-crew-pending-children-")), "runtime.db");
    const logger = new FakeLogger();
    const firstDb = new RuntimeDb({ path: dbPath, wal: true }, logger);
    const firstRegistry = createRegistry(new SqlitePendingChildRepository(firstDb.handle));
    await firstRegistry.recordSpawned({
      lineage,
      policyId: "policy-durable",
      effectiveRuntime: runtime,
      timeoutMs: 60_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    firstDb.close();

    const secondDb = new RuntimeDb({ path: dbPath, wal: true }, logger);
    const secondRepository = new SqlitePendingChildRepository(secondDb.handle);
    expect((await secondRepository.get("child-session-1"))?.policyId).toBe("policy-durable");
    secondDb.close();
  });
});

function createRegistry(
  repository: PendingChildRepository,
  eventBus: FakeEventBus = new FakeEventBus(),
): DelegatedChildRegistry {
  return new DelegatedChildRegistry({
    repository,
    eventBus,
    logger: new FakeLogger(),
  });
}
