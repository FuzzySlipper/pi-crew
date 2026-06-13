/**
 * WorkerRoleAssembly — per-role Agent assembly seam.
 *
 * Each concrete role assembly provides the prompts, tool sets, drain
 * essentials, and optional hooks needed by WorkerRuntime to construct a
 * supervised pi-agent-core Agent for that role.  This replaces the
 * hardcoded `WorkerExecutor.execute()` pattern with a role-specific
 * configuration surface that leaves the model↔tools loop to the
 * upstream Agent.
 *
 * Location: `pi-service`, not `pi-core`, because this seam references
 * pi-agent-core message/tool/hook types.  pi-core must remain the
 * foundation and must not import pi-agent-core.
 *
 * @module pi-service/workers/worker-role-assembly
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  BeforeToolCallResult,
  AfterToolCallResult,
  BeforeToolCallContext,
  AfterToolCallContext,
} from "@earendil-works/pi-agent-core";
import type { WorkerBinding, WorkerTargetPacketRef } from "../sessions/types.js";
import type { WorkerRoleConfig } from "./worker-role-config.js";

export interface WorkerProfileToolPolicy {
  readonly mode?: "allow_all" | "allow_list" | "deny_list";
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

// ── Input ────────────────────────────────────────────────────────

/**
 * Context passed to a role assembly when building prompts, messages,
 * and tool selections for a supervised Agent assignment.
 *
 * Carries Den correlation IDs, the target packet reference (for
 * packet-auditor), profile-level config, and validated runtime config
 * from the worker role mapping.
 */
export interface WorkerRoleInput {
  /** Den assignment binding with correlation IDs. */
  readonly binding: WorkerBinding;
  /** Worker session ID for this assignment. */
  readonly sessionId: string;
  /** Resolved profile ID for this worker role. */
  readonly profileId: string;
  /** Optional per-role overrides from the role mapping config. */
  readonly roleConfig?: WorkerRoleConfig;
  /** Optional profile-owned tool policy loaded from the selected profile. */
  readonly profileToolPolicy?: WorkerProfileToolPolicy;
  /**
   * Target packet reference for roles that audit or validate an
   * existing completion packet (packet-auditor, validator).
   *
   * When absent, the role is self-contained and operates on the
   * current assignment context (coder, reviewer).
   */
  readonly targetPacketRef?: TargetPacketRef;
}

/** A Den packet reference that a role assembly can use to assemble audit/validation context. */
export interface TargetPacketRef extends WorkerTargetPacketRef {}

// ── Hooks ────────────────────────────────────────────────────────

/**
 * Optional Agent hooks that a role assembly can provide.
 *
 * Typed against the exact pi-agent-core API version in use.  These
 * are passed directly to the Agent constructor and run within the
 * Agent's event pipeline.
 */
export interface WorkerRoleHooks {
  /** Pre-flight tool-call check — return `{ block: true }` to deny. */
  readonly beforeToolCall?: (
    ctx: BeforeToolCallContext,
  ) => Promise<BeforeToolCallResult | undefined>;

  /** Post-execution result scrub / classification. */
  readonly afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
}

// ── Assembly interface ───────────────────────────────────────────

/**
 * A worker role assembly builds the configuration surface for a
 * supervised pi-agent-core Agent.
 *
 * Concrete implementations live in `pi-service/src/workers/` and are
 * selected by role name at runtime (e.g., `packet-auditor-role-assembly.ts`).
 *
 * WorkerRuntime constructs the Agent from three parts:
 * 1. `buildSystemPrompt()` — the Agent's system-level instruction.
 * 2. `buildInitialMessages()` — the first user message(s) carrying the
 *    Den assignment context.
 * 3. `selectMcpToolSets()` — which MCP tool sets the Agent may discover.
 *
 * The Agent's own model↔tools loop drives execution; the role assembly
 * does NOT implement an `execute()` method.  Policy, drain, timeout,
 * and checkpoint are owned by WorkerRuntime.
 */
export interface WorkerRoleAssembly {
  /** The worker role this assembly handles. */
  readonly role: string;

  /**
   * Build the system prompt injected into the Agent.
   *
   * Includes role instructions, required field definitions, and
   * Den packet context for the assignment.
   */
  buildSystemPrompt(input: WorkerRoleInput): string;

  /**
   * Select MCP tool-set identifiers for this role.
   *
   * The runtime will discover tools from these sets and make them
   * available to the Agent.  Drain-essential tools are declared
   * separately via `drainEssentialTools()`.
   */
  selectMcpToolSets(input: WorkerRoleInput): string[];

  /**
   * Drain-essential tool names — these must remain available when the
   * runtime strips non-essential tools during drain mode.
   *
   * Always include `context_status` and any structured-completion
   * posting tool (e.g., `post_structured_completion`).
   */
  drainEssentialTools(input: WorkerRoleInput): string[];

  /**
   * Build the initial user message(s) to start the Agent.
   *
   * Typically a single message with the Den assignment context,
   * packet reference(s), and work instructions.  The Agent sees this
   * as the first user turn.
   */
  buildInitialMessages(input: WorkerRoleInput): AgentMessage[];

  /**
   * Optional Agent hooks provided by this role assembly.
   *
   * Return `undefined` when no extra hooks are needed (default).
   * Returned hooks are passed directly to the Agent constructor.
   */
  extraHooks?(input: WorkerRoleInput): WorkerRoleHooks | undefined;
}
