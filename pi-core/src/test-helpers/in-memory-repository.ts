/**
 * Generic in-memory {@link Repository} implementation for testing.
 *
 * Backed by a `Map`, it supports get, getAll, save, delete, and a simple
 * exact-match query.  The constructor accepts an `idGetter` so the store
 * can extract the key from any entity shape.
 *
 * @module pi-core/test-helpers/in-memory-repository
 */

import type { Repository } from "../repository.js";

/**
 * In-memory {@link Repository} backed by a `Map<TId, T>`.
 *
 * @typeParam T  - The entity type.
 * @typeParam TId - The identifier type (defaults to `string`).
 */
export class InMemoryRepository<T, TId = string>
  implements Repository<T, TId>
{
  private readonly store = new Map<TId, T>();

  /**
   * @param idGetter - Function that extracts the primary key from an entity.
   */
  constructor(private readonly idGetter: (entity: T) => TId) {}

  // ── Repository contract ────────────────────────────────────────

  get(id: TId): Promise<T | null> {
    return Promise.resolve(this.store.get(id) ?? null);
  }

  getAll(): Promise<T[]> {
    return Promise.resolve([...this.store.values()]);
  }

  query(filter: Record<string, unknown>): Promise<T[]> {
    const keys = Object.keys(filter);
    if (keys.length === 0) return Promise.resolve([...this.store.values()]);

    const results = [...this.store.values()].filter((entity) =>
      keys.every((key) => {
        const expected = filter[key];
        const actual = (entity as Record<string, unknown>)[key];
        if (
          typeof expected === "object" &&
          expected !== null &&
          !Array.isArray(expected)
        ) {
          return JSON.stringify(actual) === JSON.stringify(expected);
        }
        return actual === expected;
      }),
    );
    return Promise.resolve(results);
  }

  save(entity: T): Promise<T> {
    this.store.set(this.idGetter(entity), entity);
    return Promise.resolve(entity);
  }

  delete(id: TId): Promise<void> {
    this.store.delete(id);
    return Promise.resolve();
  }

  // ── Test helpers ───────────────────────────────────────────────

  /** The number of entities currently stored. */
  get size(): number {
    return this.store.size;
  }

  /** Remove every entity (useful in `beforeEach`). */
  clear(): void {
    this.store.clear();
  }
}
