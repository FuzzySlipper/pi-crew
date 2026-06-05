import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRepository } from "./in-memory-repository.js";
import type { Repository } from "../repository.js";

interface TestEntity {
  id: string;
  name: string;
  version: number;
}

describe("InMemoryRepository", () => {
  let repo: InMemoryRepository<TestEntity>;

  beforeEach(() => {
    repo = new InMemoryRepository<TestEntity>((e) => e.id);
  });

  it("satisfies the Repository interface", () => {
    const r: Repository<TestEntity> = repo;
    expect(r).toBe(repo);
  });

  it("get returns null for a missing entity", async () => {
    const result = await repo.get("missing");
    expect(result).toBeNull();
  });

  it("save and get round-trip", async () => {
    const entity: TestEntity = { id: "1", name: "alpha", version: 1 };
    const saved = await repo.save(entity);
    expect(saved).toEqual(entity);

    const fetched = await repo.get("1");
    expect(fetched).toEqual(entity);
  });

  it("getAll returns every saved entity", async () => {
    await repo.save({ id: "a", name: "first", version: 1 });
    await repo.save({ id: "b", name: "second", version: 2 });
    const all = await repo.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  it("delete removes an entity", async () => {
    await repo.save({ id: "x", name: "tmp", version: 0 });
    await repo.delete("x");
    expect(await repo.get("x")).toBeNull();
    expect(await repo.getAll()).toHaveLength(0);
  });

  it("delete is a no-op for unknown id", async () => {
    await repo.delete("nope");
    expect(await repo.getAll()).toHaveLength(0);
  });

  it("save replaces an existing entity with the same id", async () => {
    await repo.save({ id: "1", name: "v1", version: 1 });
    await repo.save({ id: "1", name: "v2", version: 2 });
    const result = await repo.get("1");
    expect(result).toEqual({ id: "1", name: "v2", version: 2 });
    expect(await repo.getAll()).toHaveLength(1);
  });

  // ── query ──────────────────────────────────────────────────

  it("query with empty filter returns all entities", async () => {
    await repo.save({ id: "1", name: "a", version: 1 });
    await repo.save({ id: "2", name: "b", version: 2 });
    const results = await repo.query({});
    expect(results).toHaveLength(2);
  });

  it("query filters by a single exact-match field", async () => {
    await repo.save({ id: "1", name: "alpha", version: 1 });
    await repo.save({ id: "2", name: "beta", version: 2 });
    await repo.save({ id: "3", name: "alpha", version: 3 });
    const results = await repo.query({ name: "alpha" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.name === "alpha")).toBe(true);
  });

  it("query filters by multiple fields (AND semantics)", async () => {
    await repo.save({ id: "1", name: "x", version: 1 });
    await repo.save({ id: "2", name: "x", version: 2 });
    await repo.save({ id: "3", name: "y", version: 2 });
    const results = await repo.query({ name: "x", version: 2 });
    expect(results).toHaveLength(1);
    const r0 = results[0];
    expect(r0).toBeDefined();
    if (r0) {
      expect(r0.id).toBe("2");
    }
  });

  it("query returns empty array when nothing matches", async () => {
    await repo.save({ id: "1", name: "a", version: 1 });
    const results = await repo.query({ name: "nonexistent" });
    expect(results).toHaveLength(0);
  });

  // ── size helper ────────────────────────────────────────────

  it("size reflects the number of stored entities", async () => {
    expect(repo.size).toBe(0);
    await repo.save({ id: "1", name: "a", version: 1 });
    expect(repo.size).toBe(1);
    await repo.save({ id: "2", name: "b", version: 2 });
    expect(repo.size).toBe(2);
    await repo.delete("1");
    expect(repo.size).toBe(1);
  });

  // ── clear helper ───────────────────────────────────────────

  it("clear removes all entities", async () => {
    await repo.save({ id: "1", name: "a", version: 1 });
    await repo.save({ id: "2", name: "b", version: 2 });
    repo.clear();
    expect(repo.size).toBe(0);
    expect(await repo.getAll()).toHaveLength(0);
  });

  // ── generic TId support ────────────────────────────────────
  it("supports numeric TId", async () => {
    interface NumEntity {
      id: number;
      label: string;
    }
    const numRepo = new InMemoryRepository<NumEntity, number>((e) => e.id);
    await numRepo.save({ id: 42, label: "answer" });
    const result = await numRepo.get(42);
    expect(result).toEqual({ id: 42, label: "answer" });
  });
});
