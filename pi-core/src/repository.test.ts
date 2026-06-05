import { describe, it, expect, beforeEach } from "vitest";
import type { Repository } from "./repository.js";

interface TestEntity {
  id: string;
  name: string;
}

/**
 * A fake in-memory repository that satisfies the Repository<T, TId> contract.
 */
class FakeRepository implements Repository<TestEntity> {
  private store = new Map<string, TestEntity>();

  get(id: string): Promise<TestEntity | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  getAll(): Promise<TestEntity[]> {
    return Promise.resolve([...this.store.values()]);
  }

  query(filter: Record<string, unknown>): Promise<TestEntity[]> {
    const nameMatch = filter["name"] as string | undefined;
    if (!nameMatch) return Promise.resolve([]);
    return Promise.resolve(
      [...this.store.values()].filter((e) => e.name === nameMatch),
    );
  }

  save(entity: TestEntity): Promise<TestEntity> {
    this.store.set(entity.id, entity);
    return Promise.resolve(entity);
  }

  delete(id: string): Promise<void> {
    this.store.delete(id);
    return Promise.resolve();
  }
}

describe("Repository interface", () => {
  let repo: FakeRepository;

  beforeEach(() => {
    repo = new FakeRepository();
  });

  it("get returns null for missing entities", async () => {
    const result = await repo.get("missing");
    expect(result).toBeNull();
  });

  it("save and get round-trip", async () => {
    const entity: TestEntity = { id: "1", name: "alpha" };
    await repo.save(entity);
    const result = await repo.get("1");
    expect(result).toEqual(entity);
  });

  it("getAll returns all saved entities", async () => {
    await repo.save({ id: "1", name: "a" });
    await repo.save({ id: "2", name: "b" });
    const all = await repo.getAll();
    expect(all).toHaveLength(2);
  });

  it("query filters by name", async () => {
    await repo.save({ id: "1", name: "alpha" });
    await repo.save({ id: "2", name: "beta" });
    const results = await repo.query({ name: "alpha" });
    expect(results).toHaveLength(1);
    const r0 = results[0];
    expect(r0).toBeDefined();
    if (r0) {
      expect(r0.id).toBe("1");
    }
  });

  it("delete removes an entity", async () => {
    await repo.save({ id: "1", name: "x" });
    await repo.delete("1");
    const result = await repo.get("1");
    expect(result).toBeNull();
  });
});
