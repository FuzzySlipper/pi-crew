/** Tests for conversational /new reset semantics. */
import { describe, expect, it } from "vitest";
import type { EventBus } from "@pi-crew/core";
import { ConversationalSessionResetService } from "../../admin/conversational-session-reset-service.js";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { InstancePool } from "../../instances/instance-pool.js";
import type { AgentInstance } from "../../instances/agent-instance.js";
import type { MessageInput, MessageRepository, MessageRow } from "../../persistence/types.js";

const session: SessionRecord = {
  id: "sess-prime-coder",
  profileId: "prime-coder",
  instanceId: "inst-old",
  kind: "conversational",
  delegation: null,
  delegationSpawnRequest: null,
  createdAt: "2026-06-13T00:00:00.000Z",
  lastActiveAt: "2026-06-13T00:00:00.000Z",
  state: "active",
  messageCount: 5,
  channelBindings: [{ providerId: "den-channels", channelId: "642" }],
  workerBinding: null,
};

describe("ConversationalSessionResetService", () => {
  it("releases the old instance, clears persisted history, reacquires the configured session, and emits reset evidence", async () => {
    const store = new InMemorySessionStore();
    await store.save(session);
    const pool = new FakeInstancePool();
    const messages = new FakeMessageRepository(9);
    const events = new FakeEventBus();
    const service = new ConversationalSessionResetService({
      sessionStore: store,
      instancePool: pool,
      messageRepository: messages,
      eventBus: events,
      now: () => "2026-06-13T00:01:00.000Z",
    });

    const result = await service.reset({
      sessionId: "sess-prime-coder",
      requestedBy: "pi-crew-runner",
      reason: "task 2417 smoke",
    });

    const updated = await store.get("sess-prime-coder");
    expect(result).toEqual({
      oldSessionId: "sess-prime-coder",
      newSessionId: "sess-prime-coder",
      oldInstanceId: "inst-old",
      newInstanceId: "inst-new-1",
      archivedMessageCount: 9,
      resetAt: "2026-06-13T00:01:00.000Z",
    });
    expect(pool.released).toEqual(["inst-old"]);
    expect(pool.acquired).toEqual([
      {
        profileId: "prime-coder",
        role: undefined,
        sessionId: "sess-prime-coder",
        kind: "conversational",
      },
    ]);
    expect(messages.deletedSessionIds).toEqual(["sess-prime-coder"]);
    expect(updated).toMatchObject({
      id: "sess-prime-coder",
      instanceId: "inst-new-1",
      messageCount: 0,
      lastActiveAt: "2026-06-13T00:01:00.000Z",
      channelBindings: session.channelBindings,
    });
    expect(events.events).toContainEqual({
      event: "session.reset",
      payload: {
        sessionId: "sess-prime-coder",
        oldInstanceId: "inst-old",
        newInstanceId: "inst-new-1",
        requestedBy: "pi-crew-runner",
        reason: "task 2417 smoke",
        resetAt: "2026-06-13T00:01:00.000Z",
        archivedMessageCount: 9,
      },
    });
  });
});

class FakeInstancePool implements InstancePool {
  readonly released: string[] = [];
  readonly acquired: Array<{
    profileId: string;
    role: string | undefined;
    sessionId: string | undefined;
    kind: "conversational" | "worker" | "delegated" | undefined;
  }> = [];
  get size(): number {
    return 1;
  }
  acquire(
    profileId: string,
    role?: string,
    _effectiveRuntime?: unknown,
    sessionId?: string,
    kind?: "conversational" | "worker" | "delegated",
  ): Promise<AgentInstance> {
    this.acquired.push({ profileId, role, sessionId, kind });
    return Promise.resolve({
      id: "inst-new-1",
      profileId,
      createdAt: new Date("2026-06-13T00:01:00.000Z"),
      isDisposed: false,
      processMessage: async () => ({ kind: "text", text: "ok" }),
      dispose: async () => {},
    });
  }
  release(instanceId: string): Promise<void> {
    this.released.push(instanceId);
    return Promise.resolve();
  }
  evictIdle(): Promise<number> {
    return Promise.resolve(0);
  }
  touch(_instanceId: string): void {}
  has(_instanceId: string): boolean {
    return true;
  }
  get(_instanceId: string): AgentInstance | undefined {
    return undefined;
  }
}

class FakeMessageRepository implements MessageRepository {
  readonly deletedSessionIds: string[] = [];
  constructor(private readonly messageCount: number) {}
  append(_input: MessageInput): Promise<number> {
    return Promise.resolve(1);
  }
  getBySession(_sessionId: string, _limit?: number): Promise<MessageRow[]> {
    return Promise.resolve([]);
  }
  getRecentBySession(_sessionId: string, _limit?: number): Promise<MessageRow[]> {
    return Promise.resolve([]);
  }
  count(_sessionId: string): Promise<number> {
    return Promise.resolve(this.messageCount);
  }
  deleteBySession(sessionId: string): Promise<void> {
    this.deletedSessionIds.push(sessionId);
    return Promise.resolve();
  }
}

class FakeEventBus implements EventBus {
  readonly events: Array<{ event: string; payload: unknown }> = [];
  emit(event: { event: string; payload: unknown }): void {
    this.events.push(event);
  }
  on(_event: string, _handler: (payload: unknown) => void): () => void {
    return () => {};
  }
  off(_event: string, _handler: (payload: unknown) => void): void {}
}
