// pi-memory — Structured blackboard and medium-term agent memory.
// DEFERRED: not part of the initial pi-crew implementation.
// Skeleton package for future integration; no business logic yet.

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface MemoryStore {
  store(entry: MemoryEntry): Promise<void>;
  query(tags: string[]): Promise<MemoryEntry[]>;
}

// Placeholder — will be wired into pi-service when memory is implemented.
export function createMemoryStore(): MemoryStore {
  throw new Error("pi-memory is deferred — not yet implemented");
}
