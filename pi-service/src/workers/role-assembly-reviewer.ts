/**
 * ReviewerRoleAssembly — supervised Agent configuration for review workers.
 *
 * The assembly owns prompt/tool configuration only. WorkerRuntime owns the
 * Agent lifecycle, policy hooks, drain mode, completion posting, and Den
 * assignment lifecycle.
 *
 * @module pi-service/workers/role-assembly-reviewer
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  WorkerRoleAssembly,
  WorkerRoleHooks,
  WorkerRoleInput,
} from "./worker-role-assembly.js";

const ROLE = "reviewer";
const DEFAULT_MCP_TOOL_SETS = [
  "filesystem_readonly",
  "git_diff_log",
  "den",
] as const;
const DEFAULT_DRAIN_ESSENTIAL_TOOLS = [
  "context_status",
  "post_structured_completion",
] as const;

/**
 * Role assembly for bounded code review workers.
 *
 * DESIGN: Keep this in pi-service because it directly references
 * pi-agent-core message types. Rationale: pi-core must remain below Agent
 * runtime dependencies and cannot import upstream Agent APIs.
 */
export const ReviewerRoleAssembly: WorkerRoleAssembly = {
  role: ROLE,

  buildSystemPrompt(input: WorkerRoleInput): string {
    const promptSource = input.roleConfig?.systemPromptSource ?? input.profileId;
    const { binding } = input;

    return [
      "You are a Reviewer worker for the Den-managed pi-crew worker system.",
      "",
      `Profile prompt source: ${promptSource}`,
      "Use that role identity for review posture, but treat Den as the workflow source of truth.",
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
      "- Read the reviewer_context_packet or review request before inspecting code.",
      "- Review only the fixed branch/head identified by Den review state.",
      "- Prefer read-only filesystem inspection plus git diff/log evidence.",
      "- Record concrete findings or set the review verdict to looks_good when clean.",
      "- Post a review_findings_packet through post_structured_completion before completion.",
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
          "Start the Den reviewer assignment from its reviewer_context_packet or review request.",
          "",
          "Assignment identifiers:",
          `- projectId: ${binding.projectId}`,
          `- taskId: ${binding.taskId}`,
          `- assignmentId: ${binding.assignmentId}`,
          `- runId: ${binding.runId}`,
          `- sessionId: ${input.sessionId}`,
          "",
          "Inspect the fixed branch/head, post concrete review findings when present, and post post_structured_completion with a review_findings_packet.",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ];
  },

  extraHooks(): WorkerRoleHooks | undefined {
    return undefined;
  },
};
