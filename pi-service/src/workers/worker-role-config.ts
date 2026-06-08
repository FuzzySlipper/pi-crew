/**
 * Worker role configuration — typed mapping from Den worker roles
 * to profile IDs with optional per-role Agent assembly metadata.
 *
 * Replaces the v1 hardcoded switch in WorkerRuntime.#resolveProfileId()
 * with validated, injectable configuration. The mapping is runtime
 * config; Den still owns assignment role/state.
 *
 * @module pi-service/workers/worker-role-config
 */

import { z } from "zod";
import { ConfigurationError } from "@pi-crew/core";

// ── Types ───────────────────────────────────────────────────────

export const REQUIRED_WORKER_ROLES = [
  "packet-auditor",
  "packet_auditor",
  "coder",
  "reviewer",
  "validator",
  "drift_checker",
] as const;

/** Per-role tool/policy defaults for supervised worker sessions. */
export interface RoleToolPolicy {
  readonly allowedTools?: string[];
  readonly deniedTools?: string[];
  readonly allowedHosts?: string[];
  readonly deniedHosts?: string[];
  readonly workdirRoot?: string;
  readonly assignmentTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly credentialScope?: string;
}

/**
 * Per-role runtime configuration for supervised Agent assembly.
 *
 * Every field is optional — omitted fields inherit gateway-level
 * defaults. This is the data that the composition root will use
 * when WorkerRuntime wraps pi-agent-core Agent in a future task.
 */
export interface WorkerRoleConfig {
  /** Model provider to use when the role overrides profile defaults. */
  readonly modelProvider?: string;
  /** Model name/ID to use when the role overrides profile defaults. */
  readonly modelName?: string;
  /** System prompt source (profile ID to load prompt from). */
  readonly systemPromptSource?: string;
  /** MCP tool set identifiers for this role. */
  readonly mcpToolSet?: string[];
  /** Drain-essential tools — must always remain available. */
  readonly drainEssentialTools?: string[];
  /** Whether this role uses deterministic response mode. */
  readonly deterministicMode?: boolean;
  /** Role-specific tool policy defaults. */
  readonly toolPolicyDefaults?: RoleToolPolicy;
}

/**
 * A single role-to-profile binding.
 *
 * Maps a Den worker role string (e.g. "coder", "packet-auditor")
 * to a profile ID with optional Agent assembly metadata.
 */
export interface WorkerRoleBinding {
  /** Worker role: "coder" | "reviewer" | "packet-auditor" | etc. */
  readonly role: string;
  /** Profile ID to resolve to. */
  readonly profileId: string;
  /** Optional role-specific runtime overrides for Agent assembly. */
  readonly config?: WorkerRoleConfig;
}

/**
 * Complete worker role mapping configuration.
 *
 * Validated at startup: must have at least one binding, no duplicate
 * roles, and every role/profiled field must be non-empty.
 */
export interface WorkerRoleMappingConfig {
  /** Role-to-profile bindings. Must be non-empty with unique roles. */
  readonly bindings: WorkerRoleBinding[];
}

// ── Zod schemas ─────────────────────────────────────────────────

const RoleToolPolicySchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  allowedHosts: z.array(z.string()).optional(),
  deniedHosts: z.array(z.string()).optional(),
  workdirRoot: z.string().min(1).optional(),
  assignmentTimeoutMs: z.number().int().positive().optional(),
  idleTimeoutMs: z.number().int().positive().optional(),
  credentialScope: z.string().min(1).optional(),
});

const WorkerRoleConfigSchema = z.object({
  modelProvider: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
  systemPromptSource: z.string().min(1).optional(),
  mcpToolSet: z.array(z.string().min(1)).optional(),
  drainEssentialTools: z.array(z.string().min(1)).optional(),
  deterministicMode: z.boolean().optional(),
  toolPolicyDefaults: RoleToolPolicySchema.optional(),
});

export const WorkerRoleBindingSchema = z.object({
  role: z.string().min(1, "Worker role binding role must not be empty"),
  profileId: z
    .string()
    .min(1, "Worker role binding profileId must not be empty"),
  config: WorkerRoleConfigSchema.optional(),
});

export const WorkerRoleMappingConfigSchema = z
  .object({
    bindings: z
      .array(WorkerRoleBindingSchema)
      .min(1, "At least one worker role binding is required"),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (let i = 0; i < value.bindings.length; i++) {
      const binding = value.bindings[i];
      if (binding === undefined) continue;
      if (seen.has(binding.role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bindings", i, "role"],
          message: `Duplicate role "${binding.role}" in worker role bindings — each role must appear exactly once`,
        });
      }
      seen.add(binding.role);
    }

    for (const role of REQUIRED_WORKER_ROLES) {
      if (!seen.has(role)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bindings"],
          message: `Missing worker role binding for required role "${role}"`,
        });
      }
    }
  });

const DEFAULT_DRAIN_ESSENTIAL_TOOLS = [
  "context_status",
  "post_structured_completion",
  "request_checkpoint",
];

export const DEFAULT_WORKER_ROLE_BINDINGS: WorkerRoleBinding[] = [
  {
    role: "packet-auditor",
    profileId: "packet-auditor",
    config: { drainEssentialTools: DEFAULT_DRAIN_ESSENTIAL_TOOLS },
  },
  {
    role: "packet_auditor",
    profileId: "packet-auditor",
    config: { drainEssentialTools: DEFAULT_DRAIN_ESSENTIAL_TOOLS },
  },
  {
    role: "coder",
    profileId: "spawned-coder",
    config: {
      systemPromptSource: "spawned-coder",
      mcpToolSet: ["filesystem", "terminal", "git", "den"],
      drainEssentialTools: DEFAULT_DRAIN_ESSENTIAL_TOOLS,
    },
  },
  {
    role: "reviewer",
    profileId: "spawned-reviewer",
    config: {
      systemPromptSource: "spawned-reviewer",
      mcpToolSet: ["filesystem_readonly", "git_diff_log", "den"],
      drainEssentialTools: DEFAULT_DRAIN_ESSENTIAL_TOOLS,
    },
  },
  { role: "validator", profileId: "spawned-validator" },
  { role: "drift_checker", profileId: "worker-drift_checker" },
];

// ── Convenience loader ──────────────────────────────────────────

/**
 * Parse and validate raw worker role mapping data.
 *
 * Returns the validated config or throws {@link ConfigurationError}
 * with a multi-line message listing every validation failure.
 *
 * @param raw - Untrusted config object (e.g. from YAML or JSON).
 * @returns Parsed and validated {@link WorkerRoleMappingConfig}.
 */
export function loadWorkerRoleMapping(
  raw: unknown,
): WorkerRoleMappingConfig {
  const result = WorkerRoleMappingConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigurationError(
      `Invalid worker role mapping configuration:\n${issues}`,
    );
  }

  return result.data;
}

/**
 * Resolve a role to its profile ID from a validated mapping.
 *
 * Throws {@link ConfigurationError} if no binding exists for the role.
 * This is the runtime equivalent of startup validation — it catches
 * runtime role strings that weren't in the config.
 */
export function resolveProfileId(
  mapping: WorkerRoleMappingConfig,
  role: string,
): string {
  const binding = mapping.bindings.find((b) => b.role === role);
  if (binding === undefined) {
    throw new ConfigurationError(
      `No role binding found for worker role "${role}" — add it to workers.bindings in crew config`,
    );
  }
  return binding.profileId;
}

/**
 * Resolve role-specific config from a validated mapping.
 *
 * Returns `undefined` when no per-role config is present
 * (valid — the caller should use gateway defaults).
 */
export function resolveRoleConfig(
  mapping: WorkerRoleMappingConfig,
  role: string,
): WorkerRoleConfig | undefined {
  return mapping.bindings.find((b) => b.role === role)?.config;
}
