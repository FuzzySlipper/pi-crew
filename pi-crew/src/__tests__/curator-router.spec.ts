/** Tests for curator HTTP router — endpoint dispatch, error handling, edge cases. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createCuratorHandler, type CuratorRouterDeps } from "../curator-router.js";
import type { Logger } from "@pi-crew/core";
import type {
  CuratorService,
  CuratorRunResult,
  CuratorStatus,
  ArchivedSkill,
} from "@pi-crew/service";

// ── Fake implementations ──────────────────────────────────────

const FAKE_STATUS: CuratorStatus = {
  lastRunAt: "2026-06-17T00:00:00.000Z",
  lastRunDurationMs: 1234,
  lastRunSummary: "Transitions: 2",
  paused: false,
  runCount: 5,
  pinnedSkills: ["skill-a"],
};

const FAKE_RUN_RESULT: CuratorRunResult = {
  runId: "curator-test-run",
  startedAt: "2026-06-17T00:00:00.000Z",
  durationMs: 1500,
  transitions: [{ type: "stale", skillName: "old", daysSinceLastUse: 45 }],
  mutations: [],
  snapshotPath: "/snaps/test/run",
  errors: [],
  summary: "1 transition(s).",
};

class FakeCuratorService implements CuratorService {
  readonly statuses: CuratorStatus[] = [];
  readonly calls: string[] = [];
  #paused = false;

  async runCuratorPass(_now: Date): Promise<CuratorRunResult> {
    this.calls.push("runCuratorPass");
    return { ...FAKE_RUN_RESULT, runId: `curator-${Date.now()}` };
  }
  async runNow(_dryRun: boolean): Promise<CuratorRunResult> {
    this.calls.push(`runNow(${_dryRun})`);
    return { ...FAKE_RUN_RESULT, runId: `curator-${Date.now()}` };
  }
  async snapshot(): Promise<string> {
    this.calls.push("snapshot");
    return "/snaps/test";
  }
  async rollback(_snapshotPath: string): Promise<void> {
    this.calls.push(`rollback(${_snapshotPath})`);
  }
  async listSnapshots(): Promise<string[]> {
    this.calls.push("listSnapshots");
    return ["run-001", "run-002"];
  }
  async listArchived(): Promise<ArchivedSkill[]> {
    this.calls.push("listArchived");
    return [{ name: "archived-1", archivedAt: "2026-01-01T00:00:00.000Z", originalPath: "/archived/1" }];
  }
  async restore(skillName: string): Promise<void> {
    this.calls.push(`restore(${skillName})`);
  }
  async pin(skillName: string): Promise<void> {
    this.calls.push(`pin(${skillName})`);
  }
  async unpin(skillName: string): Promise<void> {
    this.calls.push(`unpin(${skillName})`);
  }
  async listPinned(): Promise<string[]> {
    this.calls.push("listPinned");
    return ["pinned-1"];
  }
  async status(): Promise<CuratorStatus> {
    this.calls.push("status");
    return { ...FAKE_STATUS, paused: this.#paused };
  }
  async pause(): Promise<void> {
    this.calls.push("pause");
    this.#paused = true;
  }
  async resume(): Promise<void> {
    this.calls.push("resume");
    this.#paused = false;
  }
}

const MINIMAL_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// ── Helpers ───────────────────────────────────────────────────

function createRequest(method: string, url: string): IncomingMessage {
  return {
    method,
    url,
    headers: {},
    on: () => {},
    setEncoding: () => {},
  } as unknown as IncomingMessage;
}

function collectResponse(): { status: number; body: unknown } {
  let status = 0;
  let body = "";
  return {
    status,
    body,
  };
}

async function makeRequest(
  handler: ReturnType<typeof createCuratorHandler>,
  method: string,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const req = createRequest(method, url);
  let responseStatus = 0;
  let responseBody = "";

  const res = {
    writeHead: (s: number, _headers?: Record<string, string>) => {
      responseStatus = s;
    },
    end: (data: string) => {
      responseBody = data;
    },
  } as unknown as ServerResponse;

  await handler(req, res);
  return { status: responseStatus, body: responseBody ? JSON.parse(responseBody) : undefined };
}

// ── Tests ─────────────────────────────────────────────────────

describe("curator-router", () => {
  let curator: FakeCuratorService;
  let handler: ReturnType<typeof createCuratorHandler>;

  beforeEach(() => {
    curator = new FakeCuratorService();
    handler = createCuratorHandler({ curator, logger: MINIMAL_LOGGER });
  });

  // ── GET /api/v1/curator/status ───────────────────────────────

  it("GET /api/v1/curator/status returns status", async () => {
    const { status, body } = await makeRequest(handler, "GET", "/api/v1/curator/status");
    expect(status).toBe(200);
    expect(body).toHaveProperty("lastRunAt");
    expect(body).toHaveProperty("pinnedSkills");
    expect(curator.calls).toContain("status");
  });

  // ── POST /api/v1/curator/run ─────────────────────────────────

  it("POST /api/v1/curator/run triggers runNow(false)", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/run");
    expect(status).toBe(200);
    expect(body).toHaveProperty("runId");
    expect(curator.calls).toContain("runNow(false)");
  });

  it("POST /api/v1/curator/run?dryRun=true triggers runNow(true)", async () => {
    const { status } = await makeRequest(handler, "POST", "/api/v1/curator/run?dryRun=true");
    expect(status).toBe(200);
    expect(curator.calls).toContain("runNow(true)");
  });

  // ── POST /api/v1/curator/pause ───────────────────────────────

  it("POST /api/v1/curator/pause triggers pause", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/pause");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, paused: true });
    expect(curator.calls).toContain("pause");
  });

  // ── POST /api/v1/curator/resume ──────────────────────────────

  it("POST /api/v1/curator/resume triggers resume", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/resume");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, paused: false });
    expect(curator.calls).toContain("resume");
  });

  // ── POST /api/v1/curator/pin/:name ───────────────────────────

  it("POST /api/v1/curator/pin/test-skill pins skill", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/pin/test-skill");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, pinned: "test-skill" });
    expect(curator.calls).toContain("pin(test-skill)");
  });

  it("POST /api/v1/curator/pin/ returns 400 missing name", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/pin/");
    expect(status).toBe(400);
    expect(body).toHaveProperty("error");
  });

  // ── POST /api/v1/curator/unpin/:name ─────────────────────────

  it("POST /api/v1/curator/unpin/test-skill unpins skill", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/unpin/test-skill");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, unpinned: "test-skill" });
    expect(curator.calls).toContain("unpin(test-skill)");
  });

  // ── GET /api/v1/curator/snapshots ────────────────────────────

  it("GET /api/v1/curator/snapshots returns list", async () => {
    const { status, body } = await makeRequest(handler, "GET", "/api/v1/curator/snapshots");
    expect(status).toBe(200);
    expect(body).toHaveProperty("snapshots");
    expect(curator.calls).toContain("listSnapshots");
  });

  // ── POST /api/v1/curator/snapshots/:runId/rollback ───────────

  it("POST /api/v1/curator/snapshots/run-001/rollback rolls back", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/snapshots/run-001/rollback");
    expect(status).toBe(200);
    expect(body).toHaveProperty("ok");
  });

  it("POST /api/v1/curator/snapshots//rollback returns 400", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/snapshots//rollback");
    expect(status).toBe(400);
  });

  // ── GET /api/v1/curator/archived ─────────────────────────────

  it("GET /api/v1/curator/archived returns list", async () => {
    const { status, body } = await makeRequest(handler, "GET", "/api/v1/curator/archived");
    expect(status).toBe(200);
    expect(body).toHaveProperty("archived");
    expect(curator.calls).toContain("listArchived");
  });

  // ── POST /api/v1/curator/archived/:name/restore ──────────────

  it("POST /api/v1/curator/archived/test/restore restores", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/archived/test/restore");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, restored: "test" });
    expect(curator.calls).toContain("restore(test)");
  });

  it("POST /api/v1/curator/archived//restore returns 400", async () => {
    const { status, body } = await makeRequest(handler, "POST", "/api/v1/curator/archived//restore");
    expect(status).toBe(400);
  });

  // ── GET /api/v1/curator/reports/:runId ───────────────────────

  it("GET /api/v1/curator/reports/test-run returns report summary", async () => {
    const { status, body } = await makeRequest(handler, "GET", "/api/v1/curator/reports/test-run");
    expect(status).toBe(200);
    expect(body).toHaveProperty("runId");
    expect(body).toHaveProperty("report");
    expect(curator.calls).toContain("status");
  });

  // ── 404 ──────────────────────────────────────────────────────

  it("returns 404 for unknown routes", async () => {
    const { status, body } = await makeRequest(handler, "GET", "/api/v1/curator/unknown");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });

  it("returns 404 for unknown method on known path", async () => {
    const { status, body } = await makeRequest(handler, "DELETE", "/api/v1/curator/status");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "not_found" });
  });
});
