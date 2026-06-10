/** Tests for MessageRepository-backed conversational turn history. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Logger } from "@pi-crew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { RuntimeDb } from "../../persistence/runtime-db.js";
import { SqliteMessageRepository } from "../../persistence/message-repository.js";
import { SqliteSessionRepository } from "../../persistence/session-repository.js";
import { MessageRepositoryTurnHistory } from "../../persistence/message-turn-history.js";
import type { DatabaseConfig } from "../../config.js";
import type { SessionRecord } from "../../sessions/types.js";

const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const config = (path: string): DatabaseConfig => ({ path, wal: true });
const dbPath = (): string => `/tmp/pi-crew-test/history-${String(Date.now())}.db`;

function session(id: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    id,
    kind: "conversational",
    profileId: "runner",
    instanceId: null,
    createdAt: now,
    lastActiveAt: now,
    state: "active",
    messageCount: 0,
    channelBindings: ["channel-1"],
    workerBinding: null,
    delegation: null,
    delegationSpawnRequest: null,
  };
}

function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("MessageRepositoryTurnHistory", () => {
  let path: string;
  let db: RuntimeDb;

  beforeEach(() => {
    path = dbPath();
    db = new RuntimeDb(config(path), logger);
  });

  afterEach(() => {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  });

  it("persists Agent messages across reopen and loads bounded recent history chronologically", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session("sess-conv"));
    const history = new MessageRepositoryTurnHistory(new SqliteMessageRepository(db.handle));

    await history.append("sess-conv", userMessage("first", 1));
    await history.append("sess-conv", assistantMessage("second", 2));
    await history.append("sess-conv", userMessage("third", 3));
    db.close();

    db = new RuntimeDb(config(path), logger);
    const reopenedHistory = new MessageRepositoryTurnHistory(new SqliteMessageRepository(db.handle));

    expect(await reopenedHistory.loadRecent("sess-conv", 2)).toEqual([
      assistantMessage("second", 2),
      userMessage("third", 3),
    ]);
  });

  it("loads the actual newest bounded messages after more than the default repository window", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session("sess-long"));
    const history = new MessageRepositoryTurnHistory(new SqliteMessageRepository(db.handle));

    for (let index = 0; index < 505; index += 1) {
      await history.append("sess-long", userMessage(`message-${String(index)}`, index));
    }

    expect(await history.loadRecent("sess-long", 3)).toEqual([
      userMessage("message-502", 502),
      userMessage("message-503", 503),
      userMessage("message-504", 504),
    ]);
  });
});
