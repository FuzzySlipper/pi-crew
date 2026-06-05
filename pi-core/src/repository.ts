/**
 * Generic repository contract for persistence.
 *
 * Every entity store in pi-crew implements this interface so the
 * service layer can swap storage backends without changing business
 * logic.
 *
 * @module pi-core/repository
 */

/**
 * Generic repository for entity persistence.
 *
 * @typeParam T - The entity type.
 * @typeParam TId - The identifier type (defaults to `string`).
 */
export interface Repository<T, TId = string> {
  /**
   * Retrieve a single entity by its unique identifier.
   *
   * @returns The entity, or `null` if no entity with this id exists.
   */
  get(id: TId): Promise<T | null>;

  /**
   * Retrieve every entity in the collection.
   */
  getAll(): Promise<T[]>;

  /**
   * Run an arbitrary query against the store.
   *
   * The query shape is implementation-defined.  Callers should use
   * a typed query builder or a simple filter object that the
   * implementation knows how to translate.
   *
   * @param query - An opaque query object understood by the store.
   * @returns Matching entities (may be empty).
   */
  query(query: Record<string, unknown>): Promise<T[]>;

  /**
   * Persist an entity (insert or upsert).
   *
   * @returns The saved entity (may differ from input if the store
   *          assigns defaults or generated fields).
   */
  save(entity: T): Promise<T>;

  /**
   * Remove an entity by its unique identifier.
   */
  delete(id: TId): Promise<void>;
}
