/**
 * Dense profile memory — compact per-profile personal notes.
 *
 * This is the pi-crew equivalent of Hermes's MEMORY.md / USER.md:
 * line-oriented, two-target (memory + user), atomic with drift detection,
 * cap-enforced.  It is NOT Den memory (threaded/searchable) and NOT
 * blackboard (structured decisions/questions).  It is the agent's
 * personal pocket notebook — environment facts, conventions, tool quirks,
 * user preferences.
 *
 * @module pi-memory/dense-profile-memory-types
 */

// ── Target ──────────────────────────────────────────────────────

/** The two dense memory targets — mirrors Hermes's MEMORY.md / USER.md split. */
export type DenseMemoryTarget = "memory" | "user";

/** Write actions for the dense profile memory store. */
export type DenseMemoryAction = "add" | "replace" | "remove" | "read";

// ── Read result ─────────────────────────────────────────────────

/** Content returned by a read operation. */
export interface DenseMemoryContent {
  /** Profile owning this memory store. */
  readonly profileId: string;

  /** Which target was read. */
  readonly target: DenseMemoryTarget;

  /** Full content as newline-separated entries (same format as Hermes). */
  readonly content: string;

  /** Byte cap for this target. */
  readonly capBytes: number;

  /** Current byte usage. */
  readonly usedBytes: number;

  /** Monotonic write token for drift detection. */
  readonly writeToken: number;

  /** Number of entries (newline-separated lines). */
  readonly entryCount: number;
}

// ── Write parameters ────────────────────────────────────────────

/** Parameters for a write operation. */
export interface DenseMemoryWriteParams {
  /** Profile owning the memory store. */
  readonly profileId: string;

  /** Which target to write to. */
  readonly target: DenseMemoryTarget;

  /** The write action to perform. */
  readonly action: DenseMemoryAction;

  /**
   * Content for add/replace actions.
   * Newline-separated entries.  Ignored for remove/read actions.
   */
  readonly content?: string;

  /**
   * For replace/remove: exact-match substring identifying the entry
   * to modify.  Hermes-compatible substring matching — the first line
   * containing this substring is the target.
   */
  readonly oldText?: string;

  /**
   * Expected write token for drift detection.
   * When provided, the write only succeeds if the DB's current token
   * matches.  Omit for first writes or when drift detection is not
   * desired (e.g. fresh profile).
   */
  readonly expectedToken?: number;
}

// ── Write result ────────────────────────────────────────────────

/** Result of a write operation. */
export interface DenseMemoryWriteResult {
  /** Whether the write succeeded. */
  readonly success: boolean;

  /** Byte cap for this target (now). */
  readonly capBytes: number;

  /** Current byte usage (after write). */
  readonly usedBytes: number;

  /** New write token (monotonic counter after this write). */
  readonly newToken: number;

  /**
   * Present only on drift errors.
   * Set when expectedToken did not match the DB's current token.
   */
  readonly driftError?: string;

  /** Number of entries after this write. */
  readonly entryCount: number;
}

// ── Store interface ─────────────────────────────────────────────

/**
 * Dense profile memory store — the persistence interface.
 *
 * Implementations are provided by the runtime (pi-service) and
 * consumed by the tool layer (pi-tools).
 */
export interface DenseProfileMemoryStore {
  /** Read dense profile memory content for a profile+target. */
  read(profileId: string, target: DenseMemoryTarget): Promise<DenseMemoryContent>;

  /** Synchronous read for session-creation hydration. Only available on SQLite-backed stores. */
  readSync?(profileId: string, target: DenseMemoryTarget): DenseMemoryContent;

  /**
   * Write (add/replace/remove) with cap enforcement and drift detection.
   *
   * @returns DenseMemoryWriteResult — check `success` before using
   *   `newToken`.  On drift error the caller should re-read and retry.
   */
  write(params: DenseMemoryWriteParams): Promise<DenseMemoryWriteResult>;

  /** Export profile memory to Hermes-compatible filesystem files. */
  exportToFilesystem(profileId: string): Promise<void>;

  /** Import from Hermes-compatible filesystem files (startup / migration). */
  importFromFilesystem(profileId: string): Promise<void>;
}

// ── Default caps ────────────────────────────────────────────────

/** Default byte cap for the `memory` target (Hermes-compatible). */
export const DEFAULT_MEMORY_CAP_BYTES = 2200;

/** Default byte cap for the `user` target (Hermes-compatible). */
export const DEFAULT_USER_CAP_BYTES = 1375;

// ── Entry parsing helpers ───────────────────────────────────────

/**
 * Parse newline-separated content into entries (trimmed, non-empty).
 */
export function parseEntries(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Build content string from an array of entries (newline-separated).
 */
export function buildContent(entries: string[]): string {
  return entries.join("\n");
}

/**
 * Check whether content would exceed a byte cap.
 * Uses TextEncoder for accurate byte counts (handles multi-byte chars).
 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Find the index of the first entry whose content includes `substring`.
 * Returns -1 if not found (Hermes-compatible: first match wins).
 */
export function findEntryBySubstring(entries: string[], substring: string): number {
  return entries.findIndex((entry) => entry.includes(substring));
}

/**
 * Trim oldest entries until content is under cap bytes.
 * Returns the trimmed entries array.  Oldest = first entries.
 */
export function trimToCap(entries: string[], capBytes: number): string[] {
  while (entries.length > 0 && byteLength(entries.join("\n")) > capBytes) {
    entries.shift(); // remove oldest entry
  }
  return entries;
}
