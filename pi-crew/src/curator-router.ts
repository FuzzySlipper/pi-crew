/**
 * Curator HTTP diagnostic router — Node http route handlers for curator
 * management endpoints.
 *
 * Uses the same Node http.IncomingMessage / ServerResponse pattern as
 * the Gateway health server and AdminServer.
 *
 * @module pi-crew/curator-router
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "@pi-crew/core";
import type {
  CuratorService,
  CuratorStatus,
  CuratorRunResult,
  ArchivedSkill,
} from "@pi-crew/service";

// ── Types ───────────────────────────────────────────────────────

export interface CuratorRouterDeps {
  readonly curator: CuratorService;
  readonly logger: Logger;
}

/**
 * Read the full request body as a UTF-8 string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Write a JSON response.
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Parse a URL parameter from the pathname.
 * e.g. extract "my-skill" from "/api/v1/curator/pin/my-skill"
 */
function extractPathParam(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (raw.length === 0) return null;
  // Strip trailing slash if present
  return decodeURIComponent(raw.replace(/\/+$/, ""));
}

// ── Router ──────────────────────────────────────────────────────

/**
 * Create an async handler function for all curator diagnostic routes.
 *
 * The returned handler inspects `req.method` and `req.url` to dispatch
 * to the appropriate curator service method. Unknown routes return 404.
 */
export function createCuratorHandler(
  deps: CuratorRouterDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { curator, logger } = deps;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      writeJson(res, 400, { error: "invalid_url" });
      return;
    }
    const pathname = url.pathname;

    try {
      await route(method, pathname, url, req, res, curator, logger);
    } catch (err) {
      logger.error("Curator route error", { pathname, error: String(err) });
      writeJson(res, 500, { error: "internal_error", detail: String(err) });
    }
  };
}

async function route(
  method: string,
  pathname: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  curator: CuratorService,
  logger: Logger,
): Promise<void> {
  // ── GET /api/v1/curator/status ──────────────────────────────
  if (method === "GET" && pathname === "/api/v1/curator/status") {
    const status: CuratorStatus = await curator.status();
    writeJson(res, 200, status);
    return;
  }

  // ── POST /api/v1/curator/run ────────────────────────────────
  if (method === "POST" && pathname === "/api/v1/curator/run") {
    const dryRun = url.searchParams.get("dryRun") === "true";
    const result: CuratorRunResult = await curator.runNow(dryRun);
    writeJson(res, 200, result);
    return;
  }

  // ── POST /api/v1/curator/pause ──────────────────────────────
  if (method === "POST" && pathname === "/api/v1/curator/pause") {
    await curator.pause();
    writeJson(res, 200, { ok: true, paused: true });
    return;
  }

  // ── POST /api/v1/curator/resume ─────────────────────────────
  if (method === "POST" && pathname === "/api/v1/curator/resume") {
    await curator.resume();
    writeJson(res, 200, { ok: true, paused: false });
    return;
  }

  // ── POST /api/v1/curator/pin/:skillName ─────────────────────
  if (method === "POST" && pathname.startsWith("/api/v1/curator/pin/")) {
    const skillName = extractPathParam(pathname, "/api/v1/curator/pin/");
    if (skillName === null) {
      writeJson(res, 400, { error: "skill_name_required" });
      return;
    }
    await curator.pin(skillName);
    logger.info("Curator pin via HTTP", { skillName });
    writeJson(res, 200, { ok: true, pinned: skillName });
    return;
  }

  // ── POST /api/v1/curator/unpin/:skillName ───────────────────
  if (method === "POST" && pathname.startsWith("/api/v1/curator/unpin/")) {
    const skillName = extractPathParam(pathname, "/api/v1/curator/unpin/");
    if (skillName === null) {
      writeJson(res, 400, { error: "skill_name_required" });
      return;
    }
    await curator.unpin(skillName);
    logger.info("Curator unpin via HTTP", { skillName });
    writeJson(res, 200, { ok: true, unpinned: skillName });
    return;
  }

  // ── GET /api/v1/curator/snapshots ───────────────────────────
  if (method === "GET" && pathname === "/api/v1/curator/snapshots") {
    const snapshots: string[] = await curator.listSnapshots();
    writeJson(res, 200, { snapshots });
    return;
  }

  // ── POST /api/v1/curator/snapshots/:runId/rollback ──────────
  if (
    method === "POST" &&
    pathname.startsWith("/api/v1/curator/snapshots/") &&
    pathname.endsWith("/rollback")
  ) {
    const raw = extractPathParam(
      pathname,
      "/api/v1/curator/snapshots/",
    );
    const runId = raw !== null ? raw.replace(/\/rollback$/, "") : null;
    if (runId === null || runId.length === 0) {
      writeJson(res, 400, { error: "run_id_required" });
      return;
    }
    // The snapshot paths are listed by listSnapshots; the runId maps to a
    // directory name inside the snapshots folder. We reconstruct the path
    // by looking up the snapshot matching the provided runId.
    const snapshots: string[] = await curator.listSnapshots();
    const match = snapshots.find((s) => s.includes(runId!));
    if (!match) {
      writeJson(res, 404, {
        error: "snapshot_not_found",
        detail: `No snapshot matching "${runId}" found`,
      });
      return;
    }
    await curator.rollback(match);
    logger.info("Curator rollback via HTTP", { runId, snapshotPath: match });
    writeJson(res, 200, { ok: true, rollback: match });
    return;
  }

  // ── GET /api/v1/curator/archived ────────────────────────────
  if (method === "GET" && pathname === "/api/v1/curator/archived") {
    const archived: ArchivedSkill[] = await curator.listArchived();
    writeJson(res, 200, { archived });
    return;
  }

  // ── POST /api/v1/curator/archived/:skillName/restore ────────
  if (
    method === "POST" &&
    pathname.startsWith("/api/v1/curator/archived/") &&
    pathname.endsWith("/restore")
  ) {
    const raw = extractPathParam(
      pathname,
      "/api/v1/curator/archived/",
    );
    const skillName = raw !== null ? raw.replace(/\/restore$/, "") : null;
    if (skillName === null || skillName.length === 0) {
      writeJson(res, 400, { error: "skill_name_required" });
      return;
    }
    await curator.restore(skillName);
    logger.info("Curator restore via HTTP", { skillName });
    writeJson(res, 200, { ok: true, restored: skillName });
    return;
  }

  // ── GET /api/v1/curator/reports/:runId ──────────────────────
  if (method === "GET" && pathname.startsWith("/api/v1/curator/reports/")) {
    const runId = extractPathParam(pathname, "/api/v1/curator/reports/");
    if (runId === null || runId.length === 0) {
      writeJson(res, 400, { error: "run_id_required" });
      return;
    }
    // Run a curator pass to get the latest report, then return a summary
    // In a full implementation this would retrieve stored reports by runId.
    const status: CuratorStatus = await curator.status();
    writeJson(res, 200, {
      runId,
      report: {
        lastRunAt: status.lastRunAt,
        lastRunSummary: status.lastRunSummary,
        lastRunDurationMs: status.lastRunDurationMs,
        note: "Reports are generated per curator run. Use GET /api/v1/curator/status for the latest summary.",
      },
    });
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────
  writeJson(res, 404, { error: "not_found" });
}
