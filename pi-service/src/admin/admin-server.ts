/** Read-only local admin diagnostics HTTP server. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdminConfig } from "../config.js";
import { redactDiagnosticValue } from "../diagnostics/event-journal.js";
import type { DiagnosticsOverview } from "../diagnostics/types.js";
import type { RemediationControlService, RemediationRequest } from "./remediation-control-service.js";

export interface DiagnosticsProjector {
  projectOverview(): Promise<DiagnosticsOverview>;
}

export interface AdminServerDeps {
  readonly config: AdminConfig;
  readonly diagnostics: DiagnosticsProjector;
  readonly controls?: RemediationControlService;
}

interface RouteContext {
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

/** Serves authenticated, read-only diagnostics routes for local operators. */
export class AdminServer {
  readonly #config: AdminConfig;
  readonly #diagnostics: DiagnosticsProjector;
  readonly #controls: RemediationControlService | null;
  #server: Server | null = null;

  constructor(deps: AdminServerDeps) {
    this.#config = deps.config;
    this.#diagnostics = deps.diagnostics;
    this.#controls = deps.controls ?? null;
  }

  get host(): string {
    return this.#config.host;
  }

  get port(): number {
    const address = this.#server?.address();
    if (isAddressInfo(address)) return address.port;
    return this.#config.port;
  }

  async start(): Promise<void> {
    if (!this.#config.enabled || this.#server !== null) return;
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.#handle(req, res).catch(() => {
          writeJson(res, 500, { error: "internal_error" });
        });
      });
      server.once("error", reject);
      server.listen(this.#config.port, this.#config.host, () => {
        this.#server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    this.#server = null;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${this.#config.host}:${String(this.port)}`);
    if (method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { status: "ok", uptime: process.uptime() });
      return;
    }
    if (!url.pathname.startsWith("/admin/")) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    if (!this.#authorized(req)) {
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname.startsWith("/admin/control/")) {
      await this.#routeControl(method, url, req, res);
      return;
    }
    if (method !== "GET") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    await this.#route({ url, req, res });
  }

  async #route(context: RouteContext): Promise<void> {
    const overview = await this.#diagnostics.projectOverview();
    const pathname = context.url.pathname;
    if (pathname === "/admin/diagnostics/overview") {
      writeJson(context.res, 200, overview);
      return;
    }
    if (pathname === "/admin/diagnostics/connectivity") {
      writeJson(context.res, 200, pickConnectivity(overview));
      return;
    }
    if (pathname === "/admin/diagnostics/sessions") {
      writeJson(context.res, 200, { sessions: overview.sessions });
      return;
    }
    if (pathname.startsWith("/admin/diagnostics/sessions/")) {
      writeJson(context.res, 200, findSession(overview, pathname));
      return;
    }
    if (pathname === "/admin/diagnostics/assignments") {
      writeJson(context.res, 200, { assignments: assignmentViews(overview) });
      return;
    }
    if (pathname.startsWith("/admin/diagnostics/assignments/")) {
      writeJson(context.res, 200, findAssignment(overview, pathname));
      return;
    }
    if (pathname === "/admin/diagnostics/events") {
      writeJson(context.res, 200, { events: limitedEvents(overview, context.url) });
      return;
    }
    writeJson(context.res, 404, { error: "not_found" });
  }

  async #routeControl(
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (this.#controls === null || method !== "POST") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    const request = await readControlRequest(req);
    const pathname = url.pathname;
    if (pathname === "/admin/control/drain") {
      writeJson(res, 200, await this.#controls.drain(request));
      return;
    }
    if (pathname === "/admin/control/resume") {
      writeJson(res, 200, await this.#controls.resume(request));
      return;
    }
    if (pathname.startsWith("/admin/control/sessions/") && pathname.endsWith("/recreate-instance")) {
      const sessionId = decodeURIComponent(
        pathname.slice("/admin/control/sessions/".length, -"/recreate-instance".length),
      );
      writeJson(res, 200, await this.#controls.recreateInstance(sessionId, request));
      return;
    }
    if (pathname.startsWith("/admin/control/workers/") && pathname.endsWith("/mark-local-stale")) {
      const assignmentId = decodeURIComponent(
        pathname.slice("/admin/control/workers/".length, -"/mark-local-stale".length),
      );
      writeJson(res, 200, await this.#controls.markWorkerLocalStale(assignmentId, request));
      return;
    }
    if (pathname === "/admin/control/config/validate") {
      writeJson(res, 200, await this.#controls.validateConfig(request));
      return;
    }
    if (pathname === "/admin/control/config/reload") {
      writeJson(res, 200, await this.#controls.reloadConfig(request));
      return;
    }
    writeJson(res, 404, { error: "not_found" });
  }

  #authorized(req: IncomingMessage): boolean {
    const authorization = req.headers.authorization;
    return authorization === `Bearer ${this.#config.bearerToken}`;
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function pickConnectivity(overview: DiagnosticsOverview) {
  return {
    classification: overview.classification,
    denCore: overview.denCore,
    denChannels: overview.denChannels,
    mcp: overview.mcp,
    runtimeDb: overview.runtimeDb,
  };
}

function findSession(overview: DiagnosticsOverview, pathname: string) {
  const sessionId = decodeURIComponent(pathname.slice("/admin/diagnostics/sessions/".length));
  return overview.sessions.find((session) => session.sessionId === sessionId) ?? { error: "not_found" };
}

function assignmentViews(overview: DiagnosticsOverview) {
  return overview.sessions
    .filter((session) => session.workerBinding !== null)
    .map((session) => ({
      sessionId: session.sessionId,
      workerBinding: session.workerBinding,
      denAssignment: session.denAssignment,
      classification: session.classification,
      evidenceRefs: session.evidenceRefs,
    }));
}

function findAssignment(overview: DiagnosticsOverview, pathname: string) {
  const assignmentId = decodeURIComponent(pathname.slice("/admin/diagnostics/assignments/".length));
  return (
    assignmentViews(overview).find(
      (assignment) => assignment.workerBinding?.assignmentId === assignmentId,
    ) ?? { error: "not_found" }
  );
}

async function readControlRequest(req: IncomingMessage): Promise<RemediationRequest> {
  const parsed = parseRecord(await readBody(req));
  return {
    operator: readString(parsed, "operator"),
    reason: readString(parsed, "reason"),
    idempotencyKey: readString(parsed, "idempotencyKey"),
    dryRun: parsed["dryRun"] === true,
    candidateConfig: parsed["candidateConfig"],
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
}

function parseRecord(body: string): Record<string, unknown> {
  if (body.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function limitedEvents(overview: DiagnosticsOverview, url: URL) {
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isInteger(rawLimit) ? Math.max(0, Math.min(rawLimit, 100)) : 50;
  return overview.recentEvents.slice(-limit);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(redactDiagnosticValue(body, null)));
}

function isAddressInfo(address: string | AddressInfo | null | undefined): address is AddressInfo {
  return typeof address === "object" && address !== null;
}
