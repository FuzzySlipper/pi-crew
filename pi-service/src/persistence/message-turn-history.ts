/** MessageRepository-backed conversational Agent history adapter. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageRepository, MessageRow } from "./types.js";
import type { ConversationalTurnHistory } from "../instances/conversational-agent-responder.js";

type PersistableAgentRole = "user" | "assistant" | "tool" | "system";

/** Stores Agent messages in the runtime messages table and rehydrates recent context. */
export class MessageRepositoryTurnHistory implements ConversationalTurnHistory {
  constructor(private readonly messages: MessageRepository) {}

  async loadRecent(sessionId: string, limit: number): Promise<AgentMessage[]> {
    const rows = await this.messages.getBySession(sessionId);
    return rows.slice(-limit).map(rowToAgentMessage);
  }

  append(sessionId: string, message: AgentMessage): Promise<void> {
    return this.messages.append({
      sessionId,
      role: toPersistableRole(message.role),
      content: JSON.stringify(message),
    }).then(() => undefined);
  }
}

function rowToAgentMessage(row: MessageRow): AgentMessage {
  return JSON.parse(row.content) as AgentMessage;
}

function toPersistableRole(role: AgentMessage["role"]): PersistableAgentRole {
  if (role === "user" || role === "assistant") return role;
  return "tool";
}
