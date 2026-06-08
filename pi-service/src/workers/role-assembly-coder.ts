/**
 * CoderRoleAssembly — supervised Agent configuration for implementation workers.
 *
 * The assembly owns prompt/tool configuration only. WorkerRuntime owns the
 * Agent lifecycle, policy hooks, drain mode, completion posting, and Den
 * assignment lifecycle.
 *
 * @module pi-service/workers/role-assembly-coder
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  WorkerRoleAssembly,
  WorkerRoleInput,
  WorkerRoleHooks,
} from "./worker-role-assembly.js";

const ROLE = "coder";
const DEFAULT_MCP_TOOL_SETS = ["filesystem", "terminal", "git", "den"] as const;
const DEFAULT_DRAIN_ESSENTIAL_TOOLS = [
  "context_status",
  "post_structured_completion",
  "request_checkpoint",
] as const;

/**
 * Role assembly for bounded implementation/change workers.
 *
 * DESIGN: Keep this in pi-service because it directly references
 * pi-agent-core message types. Rationale: pi-core must remain below Agent
 * runtime dependencies and cannot import upstream Agent APIs.
 */
export const CoderRoleAssembly: WorkerRoleAssembly = {
  role: ROLE,

  buildSystemPrompt(input: WorkerRoleInput): string {
    const promptSource = input.roleConfig?.systemPromptSource ?? input.profileId;
    const { binding } = input;

    return [
      "You are a Coder worker for the Den-managed pi-crew worker system.",
      "",
      `Profile prompt source: ${promptSource}`,
      "Use that role identity for implementation posture, but treat Den as the workflow source of truth.",
      "",
      "## Den assignment context",
      `- projectId: ${binding.projectId}`,
      `- taskId: ${binding.taskId}`,
      `- assignmentId: ${binding.assignmentId}`,
      `- runId: ${binding.runId}`,
      `- role: ${binding.role}`,
      `- sessionId: ${input.sessionId}`,
      "",
      "## Required behavior",
      "- Read the coder_context_packet for the assignment before editing.",
      "- Implement only the bounded task scope and keep changes Den-visible.",
      "- Use strict TDD when behavior changes: RED, GREEN, then refactor.",
      "- Preserve package boundaries and pi-crew codebase constitution constraints.",
      "- Post an implementation_packet through post_structured_completion before completion.",
      "- Use context_status before draining or when nearing context limits.",
    ].join("\n");
  },

  selectMcpToolSets(input: WorkerRoleInput): string[] {
    return input.roleConfig?.mcpToolSet !== undefined
      ? [...input.roleConfig.mcpToolSet]
      : [...DEFAULT_MCP_TOOL_SETS];
  },

  drainEssentialTools(input: WorkerRoleInput): string[] {
    return input.roleConfig?.drainEssentialTools !== undefined
      ? [...input.roleConfig.drainEssentialTools]
      : [...DEFAULT_DRAIN_ESSENTIAL_TOOLS];
  },

  buildInitialMessages(input: WorkerRoleInput): AgentMessage[] {
    const { binding } = input;
    return [
      {
        role: "user",
        content: [
          "Start the Den coder assignment from its coder_context_packet.",
          "",
          "Assignment identifiers:",
          `- projectId: ${binding.projectId}`,
          `- taskId: ${binding.taskId}`,
          `- assignmentId: ${binding.assignmentId}`,
          `- runId: ${binding.runId}`,
          `- sessionId: ${input.sessionId}`,
          "",
          "Fetch/read the task packet, implement the requested change, run the required verification, and post post_structured_completion with an implementation_packet.",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ];
  },

  extraHooks(): WorkerRoleHooks | undefined {
    return undefined;
  },
};
