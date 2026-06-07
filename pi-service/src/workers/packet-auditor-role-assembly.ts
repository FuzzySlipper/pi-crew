/**
 * PacketAuditorRoleAssembly — first real Den-backed supervised agent
 * role.
 *
 * Replaces the hardcoded `PacketAuditor.execute()` capstone with a
 * `WorkerRoleAssembly` that provides prompts, tool-set selections,
 * and initial messages for a supervised pi-agent-core Agent.  The
 * Agent's model↔tools loop drives execution; this assembly owns role
 * configuration only.
 *
 * ## Architecture
 *
 * The Agent receives:
 * 1. A system prompt describing the audit task and required fields.
 * 2. Den MCP tools (`den_get_worker_run`, `den_get_latest_worker_completion`,
 *    `den_get_task`) for fetching the target completion packet.
 * 3. An initial user message with the target packet reference.
 *
 * The Agent's model↔tools loop fetches the packet from Den, validates
 * its fields, and posts structured findings via the completion poster.
 *
 * Hardcoded test packets (formerly `PacketAuditor.#buildTestPackets()`)
 * have been removed from the class and live only in test fakes.
 *
 * @module pi-service/workers/packet-auditor-role-assembly
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  WorkerRoleAssembly,
  WorkerRoleInput,
  WorkerRoleHooks,
} from "./worker-role-assembly.js";

// ── Role identity ────────────────────────────────────────────────

/** The canonical role string this assembly handles. */
const ROLE = "packet-auditor";

// ── Tool sets ────────────────────────────────────────────────────

/**
 * MCP tool sets available to the packet-auditor Agent.
 *
 * `den` provides Den Core tools for fetching worker runs, completion
 * packets, and task metadata.  The auditor reads (never writes) to
 * Den, so write-side tools are excluded by policy.
 */
const AUDITOR_TOOL_SETS = ["den"];

// ── Drain essentials ─────────────────────────────────────────────

/**
 * Tools that must remain available during drain mode.
 *
 * The auditor must always be able to check its own context and post
 * structured findings, even when non-essential tools are stripped
 * between turns.
 */
const DRAIN_ESSENTIAL_TOOLS = [
  "context_status",
  "post_structured_completion",
];

// ── Required field definitions (shared with packet-auditor.ts) ───

const REQUIRED_STRING_FIELDS = [
  "assignmentId",
  "runId",
  "taskId",
] as const;

const VALID_STATUSES = ["completed", "failed", "blocked", "exhausted"] as const;

const REQUIRED_ARRAY_FIELDS = [
  "artifacts",
  "filesTouched",
  "toolsUsed",
] as const;

const REQUIRED_NUMBER_FIELDS = [
  "tokensConsumed",
  "durationMs",
  "turnCount",
] as const;

// ── PacketAuditorRoleAssembly ────────────────────────────────────

/**
 * Role assembly for the packet-auditor worker role.
 *
 * Provides:
 * - A system prompt detailing required fields and validation rules.
 * - Den MCP tool sets for fetching target packets.
 * - Initial user messages with the target packet reference.
 * - Drain-essential tool names.
 *
 * No `execute()` method — the upstream Agent drives the model↔tools
 * loop.  This assembly is pure configuration.
 */
export const PacketAuditorRoleAssembly: WorkerRoleAssembly = {
  role: ROLE,

  buildSystemPrompt(input: WorkerRoleInput): string {
    const ref = input.targetPacketRef;
    const refClause =
      ref !== undefined
        ? `\n\n## Target packet\n- Project: \`${ref.projectId}\`\n- Task: \`${ref.taskId}\`\n- Run: \`${ref.runId}\``
        : "";

    return [
      "You are a Packet Auditor for the Den worker system.",
      "",
      "Your job is to validate completion packets against the Den worker contract.",
      "Use the available Den tools to fetch the target completion packet,",
      "then check every required field.  Post structured findings when done.",
      "",
      "## Required fields",
      `String fields (must be non-empty): ${REQUIRED_STRING_FIELDS.join(", ")}`,
      `Array fields (must be present, artifacts must be non-empty): ${REQUIRED_ARRAY_FIELDS.join(", ")}`,
      `Number fields (must be >= 0): ${REQUIRED_NUMBER_FIELDS.join(", ")}`,
      `Valid statuses: ${VALID_STATUSES.join(", ")}`,
      "Also required: role (non-empty string).",
      "",
      "## Rules",
      "- Read-only — do not modify any Den data.",
      "- Every finding must have a category, field, severity, and message.",
      "- Use `post_structured_completion` to post your audit report.",
      "- If the packet cannot be fetched, report a structured failure.",
      refClause,
    ].join("\n");
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  selectMcpToolSets(input: WorkerRoleInput): string[] {
    return [...AUDITOR_TOOL_SETS];
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  drainEssentialTools(input: WorkerRoleInput): string[] {
    return [...DRAIN_ESSENTIAL_TOOLS];
  },

  buildInitialMessages(input: WorkerRoleInput): AgentMessage[] {
    const ref = input.targetPacketRef;
    const packetInstruction =
      ref !== undefined
        ? `Audit the completion packet for run \`${ref.runId}\` ` +
          `in project \`${ref.projectId}\` / task \`${ref.taskId}\`. ` +
          "Use available Den tools to fetch the packet, validate all required fields, " +
          "and post your findings."
        : "Audit the completion packet assigned to this worker session. " +
          "Use available Den tools to fetch the packet, validate all required fields, " +
          "and post your findings.";

    return [
      {
        role: "user",
        content: packetInstruction,
        timestamp: Date.now(),
      },
    ];
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  extraHooks(input: WorkerRoleInput): WorkerRoleHooks | undefined {
    // No extra hooks needed for packet-auditor — the default Agent
    // hooks from WorkerRuntime policy are sufficient.
    return undefined;
  },
};
