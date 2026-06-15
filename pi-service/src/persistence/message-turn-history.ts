/** MessageRepository-backed fullAgent Agent history adapter with context preservation. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EventBus } from "@pi-crew/core";
import {
  estimateContextUsage,
  shouldCompactContext,
  type FullAgentContextUsageEstimate,
} from "../instances/full-agent-context-policy.js";
import type { MessageRepository, MessageRow } from "./types.js";
import type {
  FullAgentHistoryLoadRequest,
  FullAgentTurnHistory,
} from "../instances/full-agent-responder.js";

type PersistableAgentRole = "user" | "assistant" | "tool" | "system";

interface ContextArtifactBody {
  readonly kind: "full_agent_context_artifact";
  readonly artifactId: string;
  readonly sessionId: string;
  readonly compactedTurnRange: {
    readonly startMessageId: number;
    readonly endMessageId: number;
    readonly messageCount: number;
  };
  readonly preservedRawTurnCount: number;
  readonly headings: readonly string[];
  readonly usage: FullAgentContextUsageEstimate;
  readonly createdAt: string;
}

type ContextCompactionEvent =
  | "context.compaction.started"
  | "context.compaction.completed"
  | "context.compaction.failed"
  | "blackboard.written";

interface TurnHistoryOptions {
  readonly eventBus?: EventBus;
  readonly clock?: () => string;
}

const ARTIFACT_KIND = "full_agent_context_artifact";

/** Stores Agent messages in the runtime messages table and rehydrates compacted context. */
export class MessageRepositoryTurnHistory implements FullAgentTurnHistory {
  readonly #clock: () => string;

  constructor(
    private readonly messages: MessageRepository,
    private readonly options: TurnHistoryOptions = {},
  ) {
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async loadRecent(
    sessionId: string,
    request: FullAgentHistoryLoadRequest,
  ): Promise<AgentMessage[]> {
    const total = await this.messages.count(sessionId);
    const rows = await this.messages.getRecentBySession(sessionId, total);
    const context = await this.#preserveCompactedContext(sessionId, rows, request);
    const recentRows = rows.filter(isConversationRow).slice(-request.minimumRecentMessages);
    const recent = recentRows.map(rowToAgentMessage);
    if (context === null) return recent;
    return [artifactToSystemMessage(context), ...recent];
  }

  append(sessionId: string, message: AgentMessage): Promise<void> {
    return this.messages
      .append({
        sessionId,
        role: toPersistableRole(message.role),
        content: JSON.stringify(message),
      })
      .then(() => undefined);
  }

  async #preserveCompactedContext(
    sessionId: string,
    rows: readonly MessageRow[],
    request: FullAgentHistoryLoadRequest,
  ): Promise<ContextArtifactBody | null> {
    const conversationRows = rows.filter(isConversationRow);
    const messages = conversationRows.map(rowToAgentMessage);
    const usage = estimateContextUsage(messages, request.contextPolicy);
    this.#emitPressure(sessionId, usage);
    if (!shouldCompactContext(usage)) return latestArtifact(rows, sessionId);
    if (conversationRows.length <= request.minimumRecentMessages) return null;
    const oldRows = conversationRows.slice(0, -request.minimumRecentMessages);
    const latest = latestArtifact(rows, sessionId);
    const start = oldRows[0];
    const end = oldRows.at(-1);
    if (start === undefined || end === undefined) return null;
    if (latest?.compactedTurnRange.endMessageId === end.id) return latest;
    const artifact = buildArtifact(
      sessionId,
      oldRows,
      request.minimumRecentMessages,
      this.#clock(),
      usage,
    );
    this.#emit("context.compaction.started", artifact);
    try {
      await this.messages.append({
        sessionId,
        role: "system",
        content: JSON.stringify({ role: "user", content: JSON.stringify(artifact) }),
      });
      this.#emit("blackboard.written", artifact);
      this.#emit("context.compaction.completed", artifact);
      return artifact;
    } catch (error) {
      this.#emit("context.compaction.failed", artifact, error);
      throw error;
    }
  }

  #emitPressure(sessionId: string, usage: FullAgentContextUsageEstimate): void {
    this.options.eventBus?.emit({
      event: "context.pressure",
      payload: {
        sessionId,
        usedTokens: usage.usedTokens,
        maxTokens: usage.maxTokens,
        thresholdPercent: usage.thresholdPercent,
        thresholdTokens: usage.thresholdTokens,
        estimationMethod: usage.estimationMethod,
        contextLengthSource: usage.contextLengthSource,
      },
    });
  }

  #emit(event: ContextCompactionEvent, artifact: ContextArtifactBody, error?: unknown): void {
    if (this.options.eventBus === undefined) return;
    const payload = {
      sessionId: artifact.sessionId,
      artifactId: artifact.artifactId,
      compactedTurnRange: artifact.compactedTurnRange,
      preservedRawTurnCount: artifact.preservedRawTurnCount,
      headings: artifact.headings,
      usedTokens: artifact.usage.usedTokens,
      maxTokens: artifact.usage.maxTokens,
      thresholdPercent: artifact.usage.thresholdPercent,
      thresholdTokens: artifact.usage.thresholdTokens,
      estimationMethod: artifact.usage.estimationMethod,
      contextLengthSource: artifact.usage.contextLengthSource,
      ...(error === undefined ? {} : { error: errorMessage(error) }),
    };
    if (event === "blackboard.written") {
      this.options.eventBus.emit({
        event: "blackboard.written",
        payload: { sessionId: artifact.sessionId, entryId: artifact.artifactId },
      });
      return;
    }
    this.options.eventBus.emit({ event, payload });
  }
}

function buildArtifact(
  sessionId: string,
  rows: readonly MessageRow[],
  preservedRawTurnCount: number,
  createdAt: string,
  usage: FullAgentContextUsageEstimate,
): ContextArtifactBody {
  const start = rows[0];
  const end = rows.at(-1);
  if (start === undefined || end === undefined) {
    throw new TypeError("Cannot build context artifact for empty row range");
  }
  return {
    kind: ARTIFACT_KIND,
    artifactId: `blackboard:${sessionId}:context-${String(start.id)}-${String(end.id)}`,
    sessionId,
    compactedTurnRange: {
      startMessageId: start.id,
      endMessageId: end.id,
      messageCount: rows.length,
    },
    preservedRawTurnCount,
    headings: rows.slice(0, 6).map((row) => rowHeading(row)),
    usage,
    createdAt,
  };
}

function artifactToSystemMessage(artifact: ContextArtifactBody): AgentMessage {
  return {
    role: "user",
    content: [
      "[Full-agent compacted context headings]",
      `Artifact: ${artifact.artifactId}`,
      `Compacted messages: ${String(artifact.compactedTurnRange.startMessageId)}-${String(artifact.compactedTurnRange.endMessageId)}`,
      ...artifact.headings.map((heading) => `- ${heading}`),
      "Use blackboard/diagnostics readback to inspect the durable artifact before relying on omitted detail.",
    ].join("\n"),
    timestamp: Date.parse(artifact.createdAt),
  };
}

function latestArtifact(
  rows: readonly MessageRow[],
  sessionId: string,
): ContextArtifactBody | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const artifact = rowToArtifact(rows[index], sessionId);
    if (artifact !== null) return artifact;
  }
  return null;
}

function rowToArtifact(row: MessageRow | undefined, sessionId: string): ContextArtifactBody | null {
  if (row?.role !== "system") return null;
  const parsed = safeParseMessage(row.content);
  if (parsed?.role !== "user" || typeof parsed.content !== "string") return null;
  const artifact = safeParseArtifact(parsed.content);
  if (artifact?.kind !== ARTIFACT_KIND || artifact.sessionId !== sessionId) return null;
  return artifact;
}

function isConversationRow(row: MessageRow): boolean {
  return rowToArtifact(row, row.session_id) === null;
}

function rowToAgentMessage(row: MessageRow): AgentMessage {
  return JSON.parse(row.content) as AgentMessage;
}

function rowHeading(row: MessageRow): string {
  const message = rowToAgentMessage(row);
  return `${String(row.id)} ${String(message.role)} at ${row.created_at}`;
}

function toPersistableRole(role: AgentMessage["role"]): PersistableAgentRole {
  if (role === "user" || role === "assistant") return role;
  return "tool";
}

function safeParseMessage(value: string): AgentMessage | null {
  try {
    return JSON.parse(value) as AgentMessage;
  } catch {
    return null;
  }
}

function safeParseArtifact(value: string): ContextArtifactBody | null {
  try {
    return JSON.parse(value) as ContextArtifactBody;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
