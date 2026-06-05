/**
 * Tests for SessionStore + InMemorySessionStore.
 *
 * @module pi-service/__tests__/sessions/session-store.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySessionStore } from "../../sessions/session-store.js";
import type { SessionRecord } from "../../sessions/types.js";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "sess-test-1",
    profileId: "default",
    instanceId: "inst-1",
    kind: "conversational",
    createdAt: now,
    lastActiveAt: now,
    state: "active",
    messageCount: 0,
    channelBindings: [],
    workerBinding: null,
    ...overrides,
  };
}

describe("InMemorySessionStore", () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  describe("save and get", () => {
    it("persists and retrieves a session record", async () => {
      const record = makeRecord();
      await store.save(record);

      const retrieved = await store.get(record.id);
      expect(retrieved).toEqual(record);
    });

    it("returns null for unknown id", async () => {
      const retrieved = await store.get("nonexistent");
      expect(retrieved).toBeNull();
    });

    it("returns null for archived sessions", async () => {
      const record = makeRecord({ state: "archived" });
      await store.save(record);

      const retrieved = await store.get(record.id);
      expect(retrieved).toBeNull();
    });

    it("upserts by replacing an existing record", async () => {
      const record = makeRecord();
      await store.save(record);

      const updated = makeRecord({ messageCount: 5 });
      await store.save(updated);

      const retrieved = await store.get(record.id);
      expect(retrieved?.messageCount).toBe(5);
    });
  });

  describe("findByChannel", () => {
    it("finds a session bound to a channel", async () => {
      const record = makeRecord({ channelBindings: ["ch-alpha"] });
      await store.save(record);

      const found = await store.findByChannel("ch-alpha");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(record.id);
    });

    it("returns null when no session is bound to the channel", async () => {
      const found = await store.findByChannel("ch-nonexistent");
      expect(found).toBeNull();
    });

    it("skips archived sessions when finding by channel", async () => {
      const record = makeRecord({
        channelBindings: ["ch-alpha"],
        state: "archived",
      });
      await store.save(record);

      const found = await store.findByChannel("ch-alpha");
      expect(found).toBeNull();
    });

    it("returns the first matching session", async () => {
      const r1 = makeRecord({ id: "sess-1", channelBindings: ["ch-shared"] });
      const r2 = makeRecord({ id: "sess-2", channelBindings: ["ch-shared"] });
      await store.save(r1);
      await store.save(r2);

      const found = await store.findByChannel("ch-shared");
      expect(found).not.toBeNull();
    });
  });

  describe("findByState", () => {
    it("returns sessions in the requested state", async () => {
      await store.save(makeRecord({ id: "sess-1", state: "active" }));
      await store.save(makeRecord({ id: "sess-2", state: "idle" }));
      await store.save(makeRecord({ id: "sess-3", state: "active" }));

      const active = await store.findByState("active");
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.id).sort()).toEqual(["sess-1", "sess-3"]);
    });

    it("returns empty array for state with no matches", async () => {
      const results = await store.findByState("archived");
      expect(results).toEqual([]);
    });
  });

  describe("delete", () => {
    it("removes a record", async () => {
      const record = makeRecord();
      await store.save(record);
      expect(store.size).toBe(1);

      await store.delete(record.id);
      expect(store.size).toBe(0);
    });

    it("is a no-op for unknown id", async () => {
      await store.delete("nonexistent");
      expect(store.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all records", async () => {
      await store.save(makeRecord({ id: "sess-1" }));
      await store.save(makeRecord({ id: "sess-2" }));
      expect(store.size).toBe(2);

      store.clear();
      expect(store.size).toBe(0);
    });
  });
});
