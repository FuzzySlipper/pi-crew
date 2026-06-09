/**
 * Security primitives for agent execution constraints.
 *
 * These foundation types describe the policy vocabulary shared by worker,
 * conversational, and delegated sessions. Runtime modules enforce these
 * constraints; agents do not self-police them.
 *
 * @module pi-core/security
 */

// ── Credential access ──────────────────────────────────────────

/** Hierarchical credential access levels. */
export type CredentialAccessLevel =
  | "none"
  | "read_only"
  | "bounded_write"
  | "full";

// ── Execution policy ───────────────────────────────────────────

/**
 * Generic execution constraints for any agent session.
 *
 * Worker sessions derive this from Den assignment and role config.
 * Conversational sessions can derive it from profile config. Delegated
 * sessions receive a stricter child policy derived from their parent.
 */
export interface ExecutionPolicy {
  /** Correlation identifier for logging and policy events. */
  readonly policyId: string;

  // Filesystem
  /** Root directory for relative path resolution. */
  readonly rootPath: string;
  /** Paths the session can read/write. Empty = rootPath only. */
  readonly allowedPaths: string[];
  /** Explicitly denied paths (overrides allowedPaths). */
  readonly denyPaths: string[];

  // Tools
  /** Tool allowlist (empty = all allowed, subject to denylist). */
  readonly allowedTools: string[];
  /** Explicitly denied tool names (overrides allowlist). */
  readonly deniedTools: string[];

  // Network
  /** Domains/IPs the session can reach (empty = all allowed). */
  readonly allowedHosts: string[];
  /** Explicitly denied hosts. */
  readonly deniedHosts: string[];

  // Time
  /** Hard timeout for the entire session (ms). */
  readonly maxDurationMs: number;
  /** Per-turn timeout (ms). */
  readonly maxTurnDurationMs: number;
  /** Max time between activity before considered stuck (ms). */
  readonly idleTimeoutMs: number;

  // Budget
  /** Max tool-calling loop iterations. */
  readonly maxIterations: number;
  /** Soft cap for context usage per turn. */
  readonly maxTokensPerTurn: number;

  // Credentials
  /** Credential scope for this session. */
  readonly credentialScope: CredentialAccessLevel;
}

/** Result of a policy enforcement check. */
export interface PolicyCheckResult {
  readonly allowed: boolean;
  readonly reason: string;
}

// ── Sandbox foundation ─────────────────────────────────────────

/** Isolation level for agent execution. */
export type SandboxLevel = "policy" | "process" | "container";

/** Contract for a sandbox backend implementation. */
export interface SandboxBackend {
  /** The isolation level this backend provides. */
  readonly level: SandboxLevel;
  /** Prepare a sandboxed execution context for a session. */
  prepare(policy: ExecutionPolicy): Promise<SandboxContext>;
  /** Tear down the sandbox after session ends. */
  destroy(context: SandboxContext): Promise<void>;
}

/** Opaque handle returned by a sandbox backend. */
export interface SandboxContext {
  /** The policy/session this sandbox was prepared for. */
  readonly policyId: string;
  /** Which backend level is active. */
  readonly level: SandboxLevel;
}
