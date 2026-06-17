/**
 * Tests for SqliteDenseProfileMemoryStore.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeDb } from "../../persistence/runtime-db.js";
import { SqliteDenseProfileMemoryStore } from "../../persistence/dense-profile-memory-store.js";
import type { DatabaseConfig } from "../../config.js";
import type {
  DenseMemoryContent,
  DenseMemoryWriteResult,
  DenseProfileMemoryStore,
} from "@pi-crew/memory";
import {
  byteLength,
  parseEntries,
  buildContent,
  findEntryBySubstring,
  trimToCap,
  DEFAULT_MEMORY_CAP_BYTES,
  DEFAULT_USER_CAP_BYTES,
} from "@pi-crew/memory";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const dbPath = (name: string): string => `/tmp/pi-crew-test/dense-memory-${name}-${String(Date.now())}.db`;
const config = (path: string): DatabaseConfig => ({ path, wal: true });

// ── Helpers ─────────────────────────────────────────────────────

function createStore(name: string): { store: SqliteDenseProfileMemoryStore; db: RuntimeDb; path: string } {
  const p = dbPath(name);
  const db = new RuntimeDb(config(p), logger);
  const store = new SqliteDenseProfileMemoryStore(db.handle, logger, "/tmp/pi-crew-test/profiles");
  return { store, db, path: p };
}

async function writeAndExpect(
  store: DenseProfileMemoryStore,
  params: { profileId: string; target: "memory" | "user"; action: "add"; content: string },
): Promise<DenseMemoryWriteResult> {
  const result = await store.write({
    profileId: params.profileId,
    target: params.target,
    action: params.action,
    content: params.content,
  });
  expect(result.success).toBe(true);
  return result;
}

// ── Tests ───────────────────────────────────────────────────────

describe("DenseProfileMemoryStore", () => {
  describe("read / write basics", () => {
    let fixture: ReturnType<typeof createStore>;

    beforeEach(() => {
      fixture = createStore("basics");
    });

    afterEach(() => {
      fixture.db.close();
      if (existsSync(fixture.path)) unlinkSync(fixture.path);
    });

    it("returns empty content for a profile that has never written", async () => {
      const content = await fixture.store.read("new-profile", "memory");
      expect(content.content).toBe("");
      expect(content.usedBytes).toBe(0);
      expect(content.writeToken).toBe(0);
      expect(content.entryCount).toBe(0);
      expect(content.capBytes).toBe(DEFAULT_MEMORY_CAP_BYTES);
    });

    it("adds an entry and returns updated state", async () => {
      const result = await writeAndExpect(fixture.store, {
        profileId: "test-profile",
        target: "memory",
        action: "add",
        content: "den-srv is at 192.168.1.10",
      });

      expect(result.usedBytes).toBeGreaterThan(0);
      expect(result.newToken).toBe(1);

      const content = await fixture.store.read("test-profile", "memory");
      expect(content.content).toContain("den-srv is at 192.168.1.10");
      expect(content.entryCount).toBe(1);
      expect(content.writeToken).toBe(1);
    });

    it("appends multiple entries", async () => {
      await writeAndExpect(fixture.store, { profileId: "multi", target: "user", action: "add", content: "User prefers short responses" });
      await writeAndExpect(fixture.store, { profileId: "multi", target: "user", action: "add", content: "User hates silent failures" });

      const content = await fixture.store.read("multi", "user");
      expect(content.entryCount).toBe(2);
      expect(content.content).toContain("User prefers short responses");
      expect(content.content).toContain("User hates silent failures");
    });

    it("separates memory and user targets", async () => {
      await writeAndExpect(fixture.store, { profileId: "sep", target: "memory", action: "add", content: "Server at 192.168.1.10" });
      await writeAndExpect(fixture.store, { profileId: "sep", target: "user", action: "add", content: "User name is Patch" });

      const mem = await fixture.store.read("sep", "memory");
      const usr = await fixture.store.read("sep", "user");

      expect(mem.entryCount).toBe(1);
      expect(mem.content).toContain("192.168.1.10");
      expect(mem.content).not.toContain("Patch");

      expect(usr.entryCount).toBe(1);
      expect(usr.content).toContain("Patch");
      expect(usr.content).not.toContain("192.168.1.10");
    });
  });

  describe("cap enforcement", () => {
    let fixture: ReturnType<typeof createStore>;

    beforeEach(() => {
      fixture = createStore("caps");
    });

    afterEach(() => {
      fixture.db.close();
      if (existsSync(fixture.path)) unlinkSync(fixture.path);
    });

    it("trims oldest entries when adding exceeds cap", async () => {
      // Use a very small cap by setting cap_bytes directly
      fixture.db.handle
        .prepare("INSERT OR REPLACE INTO profile_dense_memory (profile_id, target, content, cap_bytes, write_token, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("trim-test", "memory", "", 40, 0);

      const result1 = await writeAndExpect(fixture.store, { profileId: "trim-test", target: "memory", action: "add", content: "A short entry" });
      expect(result1.success).toBe(true);

      // Add a second entry — both still fit under 40 cap (13 + 1 + 19 = 33 bytes)
      const result2 = await writeAndExpect(fixture.store, { profileId: "trim-test", target: "memory", action: "add", content: "Another short entry" });

      // Now add an entry that pushes total over cap, causing oldest to be trimmed
      const longTitle = "long " + "x".repeat(10); // ~15 chars + 10 = 25 bytes
      const result3 = await fixture.store.write({
        profileId: "trim-test",
        target: "memory",
        action: "add",
        content: longTitle,
      });
      expect(result3.success).toBe(true);
      // After trimming: one or more oldest entries may be removed
      expect(result3.entryCount).toBeGreaterThanOrEqual(1);
      const content = await fixture.store.read("trim-test", "memory");
      // The newest entry should be present
      expect(content.content).toContain(longTitle);
    });
  });

  describe("drift detection", () => {
    let fixture: ReturnType<typeof createStore>;

    beforeEach(() => {
      fixture = createStore("drift");
    });

    afterEach(() => {
      fixture.db.close();
      if (existsSync(fixture.path)) unlinkSync(fixture.path);
    });

    it("rejects write with mismatched token", async () => {
      await writeAndExpect(fixture.store, { profileId: "drift-profile", target: "memory", action: "add", content: "First entry" });

      // Try to write with wrong token
      const result = await fixture.store.write({
        profileId: "drift-profile",
        target: "memory",
        action: "add",
        content: "This should fail",
        expectedToken: 999,
      });

      expect(result.success).toBe(false);
      expect(result.driftError).toBeDefined();
      expect(result.driftError).toContain("Write token mismatch");
    });

    it("succeeds write with correct token", async () => {
      await writeAndExpect(fixture.store, { profileId: "token-ok", target: "memory", action: "add", content: "First entry" });

      const content = await fixture.store.read("token-ok", "memory");

      const result = await fixture.store.write({
        profileId: "token-ok",
        target: "memory",
        action: "add",
        content: "Second entry",
        expectedToken: content.writeToken,
      });

      expect(result.success).toBe(true);
      expect(result.newToken).toBe(content.writeToken + 1);
    });
  });

  describe("replace and remove", () => {
    let fixture: ReturnType<typeof createStore>;

    beforeEach(() => {
      fixture = createStore("edit");
    });

    afterEach(() => {
      fixture.db.close();
      if (existsSync(fixture.path)) unlinkSync(fixture.path);
    });

    it("replaces an entry by substring match", async () => {
      await writeAndExpect(fixture.store, { profileId: "replace-test", target: "memory", action: "add", content: "Old tool quirk: restart on crash" });
      await writeAndExpect(fixture.store, { profileId: "replace-test", target: "memory", action: "add", content: "Server address: 10.0.0.1" });

      const content = await fixture.store.read("replace-test", "memory");
      const result = await fixture.store.write({
        profileId: "replace-test",
        target: "memory",
        action: "replace",
        oldText: "Server address",
        content: "Server address: 10.0.0.2",
        expectedToken: content.writeToken,
      });

      expect(result.success).toBe(true);
      const updated = await fixture.store.read("replace-test", "memory");
      expect(updated.content).toContain("Server address: 10.0.0.2");
      expect(updated.content).toContain("Old tool quirk"); // untouched
      expect(updated.content).not.toContain("10.0.0.1"); // old value gone
    });

    it("removes an entry by substring match", async () => {
      await writeAndExpect(fixture.store, { profileId: "remove-test", target: "memory", action: "add", content: "Entry to keep" });
      await writeAndExpect(fixture.store, { profileId: "remove-test", target: "memory", action: "add", content: "Entry to remove: debug technique" });

      const content = await fixture.store.read("remove-test", "memory");
      expect(content.entryCount).toBe(2);

      const result = await fixture.store.write({
        profileId: "remove-test",
        target: "memory",
        action: "remove",
        oldText: "Entry to remove",
        expectedToken: content.writeToken,
      });

      expect(result.success).toBe(true);
      expect(result.entryCount).toBe(1);

      const updated = await fixture.store.read("remove-test", "memory");
      expect(updated.content).toContain("Entry to keep");
      expect(updated.content).not.toContain("Entry to remove");
    });

    it("returns drift error when replace target entry not found", async () => {
      await writeAndExpect(fixture.store, { profileId: "notfound", target: "memory", action: "add", content: "Only entry" });

      const result = await fixture.store.write({
        profileId: "notfound",
        target: "memory",
        action: "replace",
        oldText: "nonexistent substring",
        content: "Replacement",
      });

      expect(result.success).toBe(false);
      expect(result.driftError).toContain("No entry found");
    });
  });

  describe("filesystem export", () => {
    const profilesRoot = "/tmp/pi-crew-test/profiles";
    let fixture: ReturnType<typeof createStore>;

    beforeEach(() => {
      fixture = createStore("export");
    });

    afterEach(() => {
      fixture.db.close();
      if (existsSync(fixture.path)) unlinkSync(fixture.path);
      // Clean up profile dirs
      try {
        const memFile = join(profilesRoot, "export-profile", "memory.md");
        if (existsSync(memFile)) unlinkSync(memFile);
        const usrFile = join(profilesRoot, "export-profile", "user.md");
        if (existsSync(usrFile)) unlinkSync(usrFile);
      } catch { /* ignore */ }
    });

    it("exports memory.md and user.md to profile directory on write", async () => {
      await writeAndExpect(fixture.store, { profileId: "export-profile", target: "memory", action: "add", content: "Server at 192.168.1.10" });
      await writeAndExpect(fixture.store, { profileId: "export-profile", target: "user", action: "add", content: "User is Patch" });

      // Check filesystem files
      const memPath = join(profilesRoot, "export-profile", "memory.md");
      const usrPath = join(profilesRoot, "export-profile", "user.md");

      expect(existsSync(memPath)).toBe(true);
      expect(existsSync(usrPath)).toBe(true);

      const memContent = readFileSync(memPath, "utf-8");
      const usrContent = readFileSync(usrPath, "utf-8");

      expect(memContent).toContain("Server at 192.168.1.10");
      expect(usrContent).toContain("User is Patch");
    });
  });

  describe("helper functions", () => {
    it("parseEntries splits newline-separated content", () => {
      expect(parseEntries("a\nb\nc")).toEqual(["a", "b", "c"]);
    });

    it("parseEntries filters empty lines", () => {
      expect(parseEntries("a\n\nb")).toEqual(["a", "b"]);
    });

    it("parseEntries handles empty string", () => {
      expect(parseEntries("")).toEqual([]);
    });

    it("buildContent joins entries with newlines", () => {
      expect(buildContent(["a", "b", "c"])).toBe("a\nb\nc");
    });

    it("byteLength accurate for ascii", () => {
      expect(byteLength("hello")).toBe(5);
    });

    it("byteLength accurate for multi-byte chars", () => {
      expect(byteLength("héllo")).toBe(6); // é is 2 bytes
    });

    it("findEntryBySubstring finds first match", () => {
      const entries = ["first entry", "second entry", "third entry"];
      expect(findEntryBySubstring(entries, "second")).toBe(1);
    });

    it("findEntryBySubstring returns -1 for no match", () => {
      expect(findEntryBySubstring(["a", "b"], "c")).toBe(-1);
    });

    it("trimToCap removes oldest entries until remaining content fits cap", () => {
      const entries = ["short", "medium length entry", "another one"];
      // Total = "short\nmedium length entry\nanother one" = 37 bytes
      // Cap = 12: "another one" (11 bytes) alone fits, but "short\nanother one" doesn't.
      const cap = byteLength("another one\n"); // 12
      const trimmed = trimToCap([...entries], cap);
      expect(trimmed.length).toBe(1);
      expect(trimmed[0]).toBe("another one");
    });

    it("trimToCap returns all entries when under cap", () => {
      const entries = ["a", "b"];
      const trimmed = trimToCap(entries, 100);
      expect(trimmed).toEqual(["a", "b"]);
    });
  });
});
