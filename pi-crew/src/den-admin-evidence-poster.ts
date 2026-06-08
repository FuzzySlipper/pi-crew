/** Den-visible evidence poster for operator-initiated admin controls. */
import type { Logger } from "@pi-crew/core";
import type {
  DenEvidence,
  RemediationEvidenceInput,
  RemediationEvidencePoster,
} from "@pi-crew/service";
import type { MCPClient } from "@pi-crew/mcp";

export interface DenAdminEvidencePosterConfig {
  readonly mcpClient: MCPClient;
  readonly projectId: string;
  readonly sender: string;
  readonly logger?: Logger;
}

/**
 * Builds a Den notification poster for local admin controls.
 *
 * The admin API must not mutate Den workflow state directly; this poster only
 * emits operator-visible evidence when Den MCP is reachable.
 */
export function createDenAdminEvidencePoster(
  config: DenAdminEvidencePosterConfig,
): RemediationEvidencePoster {
  const { mcpClient, projectId, sender, logger } = config;
  return {
    async postEvidence(input: RemediationEvidenceInput): Promise<DenEvidence> {
      const content = buildContent(input);
      const result = await mcpClient.callTool("send_user_notification", {
        project_id: projectId,
        sender,
        content,
        urgency: "low",
        metadata: {
          type: "admin_control_evidence",
          action: input.action,
          accepted: input.accepted,
          dry_run: input.dryRun,
          idempotency_key: input.idempotencyKey,
        },
      });
      if (!result.ok) {
        logger?.warn("Den admin evidence post failed", {
          action: input.action,
          error: result.error,
        });
        return { posted: false, messageId: null, notificationId: null, status: result.error };
      }
      return {
        posted: true,
        messageId: null,
        notificationId: extractFirstInteger(extractMessage(result.content)),
        status: "notification_posted",
      };
    },
  };
}

function buildContent(input: RemediationEvidenceInput): string {
  return [
    `Admin control ${input.action}: ${input.accepted ? "accepted" : "denied"}`,
    `operator=${input.operator}`,
    `dryRun=${String(input.dryRun)}`,
    `idempotencyKey=${input.idempotencyKey}`,
    `reason=${input.reason}`,
    `beforeKeys=${Object.keys(input.before).join(",")}`,
    `afterKeys=${input.after === null ? "null" : Object.keys(input.after).join(",")}`,
    input.warnings.length === 0 ? "warnings=none" : `warnings=${input.warnings.join("; ")}`,
  ].join("\n");
}

function extractMessage(content: ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function extractFirstInteger(text: string): number | null {
  const match = text.match(/\b\d+\b/u);
  return match === null ? null : Number(match[0]);
}
