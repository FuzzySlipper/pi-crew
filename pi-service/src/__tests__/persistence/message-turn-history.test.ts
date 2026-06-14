/** Tests for MessageRepository-backed fullAgent turn history. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Logger } from "@pi-crew/core";
import { FakeEventBus } from "@pi-crew/core";
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
    kind: "full",
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
    const reopenedHistory = new MessageRepositoryTurnHistory(
      new SqliteMessageRepository(db.handle),
    );

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
      expect.objectContaining({ role: "user" }),
      userMessage("message-502", 502),
      userMessage("message-503", 503),
      userMessage("message-504", 504),
    ]);
  });

  it("preserves old full-agent turns as a durable compacted context artifact", async () => {
    const sessions = new SqliteSessionRepository(db.handle, logger);
    await sessions.save(session("sess-compact"));
    const eventBus = new FakeEventBus();
    const repository = new SqliteMessageRepository(db.handle);
    const history = new MessageRepositoryTurnHistory(repository, {
      eventBus,
      clock: () => "2026-06-14T00:00:00.000Z",
    });

    await history.append("sess-compact", userMessage("decision: use blackboard headings", 1));
    await history.append("sess-compact", assistantMessage("acknowledged", 2));
    await history.append("sess-compact", userMessage("recent question", 3));

    const prompt = await history.loadRecent("sess-compact", 1);
    const artifactRows = await repository.getBySession("sess-compact");
    const artifactRow = artifactRows.find((row) => row.role === "system");

    expect(prompt).toHaveLength(2);
    expect(prompt[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Full-agent compacted context headings"),
      }),
    );
    expect(JSON.stringify(prompt[0])).not.toContain("decision: use blackboard headings");
    expect(prompt.at(-1)).toEqual(userMessage("recent question", 3));
    expect(artifactRow?.content).toContain("full_agent_context_artifact");
    expect(eventBus.emitted.map((event) => event.event)).toEqual([
      "context.compaction.started",
      "blackboard.written",
      "context.compaction.completed",
    ]);
  });
});
