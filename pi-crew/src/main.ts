/**
 * pi-crew service entrypoint — executable main for long-lived service process.
 *
 * Startup sequence (hardened):
 * 1. Resolve config path, read raw YAML for health port defaults
 * 2. Start a degraded health server on the configured port BEFORE loading
 *    the full crew config — so the process always has a listening port
 * 3. Try to load crew config with per-agent error isolation
 * 4a. On success: stop degraded server → proceed with normal startup
 * 4b. On failure: keep degraded server alive → watch config file → retry
 *
 * This prevents config typos from causing an infinite crash loop.
 *
 * @module pi-crew/main
 */

import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { env, argv, exit, stdout } from "node:process";
import { FakeEventBus } from "@pi-crew/core";
import {
  Crew,
  resolveCrewConfigPath,
  resolveCrewInstallLayout,
  tryLoadCrewConfigDegraded,
  type CrewConfig,
} from "./crew.js";
import { createCrewAssignmentLoops } from "./crew-assignment-loops.js";
import type { DenAssignmentLoop } from "./den-assignment-loop.js";
import { createDenPoolMemberReconciler } from "./den-pool-source.js";
import { ServiceConsoleLogger, subscribeServiceEventLogs } from "./service-logger.js";
import { resolveWorkerPoolCleanupGroups, resolveWorkerPoolMembers } from "./worker-pool-groups.js";
import { DegradedHealthServer } from "./degraded-health-server.js";
import type { ConfigDegradedResult } from "./degraded-health-server.js";

// ── Default health config (matches Gateway's default) ────────────────

const DEFAULT_HEALTH_HOST = "127.0.0.1";
const DEFAULT_HEALTH_PORT = 9236;

// ── Degraded-mode helpers ────────────────────────────────────────────

/**
 * Extract a best-effort health config from raw YAML without full schema
 * validation. This lets the degraded server bind to the port the operator
 * expects, even when the rest of the config is invalid.
 */
function extractHealthConfig(yamlPath: string): { host: string; port: number } {
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed: unknown = parseYaml(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const health = record["health"];
      if (typeof health === "object" && health !== null) {
        const h = health as Record<string, unknown>;
        const host = typeof h["host"] === "string" && h["host"].length > 0 ? h["host"] : DEFAULT_HEALTH_HOST;
        const port = typeof h["port"] === "number" && h["port"] > 0 && h["port"] <= 65535 ? h["port"] : DEFAULT_HEALTH_PORT;
        // Only use extracted values when at least one is explicitly set
        return { host, port };
      }
    }
  } catch {
    // If we can't even read the file, use defaults
  }
  return { host: DEFAULT_HEALTH_HOST, port: DEFAULT_HEALTH_PORT };
}

/**
 * Best-effort config path resolution before the Crew config system is
 * available. Handles env var and --config CLI arg.
 */
function earlyConfigPath(): string {
  return resolveCrewConfigPath({ argv, env, cwd: process.cwd() });
}

// ── Health smoke ────────────────────────────────────────────────

interface HealthResponse {
  status: string;
  uptime?: number;
}

/**
 * Perform a local health-check smoke request against the gateway.
 */
async function healthSmoke(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${String(port)}/`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      console.warn(`Health smoke returned HTTP ${String(response.status)} from ${url}`);
      return false;
    }
    const body = (await response.json()) as HealthResponse;
    console.log(`Health smoke OK: status=${body.status}, uptime=${String(body.uptime ?? "n/a")}s`);
    return body.status === "ok";
  } catch (error: unknown) {
    console.warn(`Health smoke failed: ${url} — ${(error as Error).message}`);
    return false;
  }
}

// ── Signal handling ─────────────────────────────────────────────

type ShutdownFn = () => Promise<void>;

function installSignalHandlers(stop: ShutdownFn): void {
  let shuttingDown = false;

  const handler = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    stop()
      .then(() => {
        exit(0);
      })
      .catch((error: unknown) => {
        console.error("Shutdown error:", (error as Error).message);
        exit(1);
      });
  };

  process.on("SIGINT", () => {
    handler("SIGINT");
  });
  process.on("SIGTERM", () => {
    handler("SIGTERM");
  });
}

// ── Normal startup (after successful config load) ───────────────

async function startCrew(
  config: CrewConfig,
  configPath: string,
  skippedAgentErrors: Array<{ field: string; message: string }>,
): Promise<{ crew: Crew; stop: () => Promise<void> }> {
  const logger = new ServiceConsoleLogger(config.logging);
  const eventBus = new FakeEventBus();
  const unsubscribeServiceEventLogs = subscribeServiceEventLogs(eventBus, logger);
  const crew = new Crew(config, logger, eventBus);
  let assignmentLoops: DenAssignmentLoop[] = [];

  // Log any skipped agents
  for (const err of skippedAgentErrors) {
    logger.warn("config.agent_skipped", { field: err.field, detail: err.message });
  }

  const stop = async () => {
    await Promise.all(assignmentLoops.map((loop) => loop.stop("signal")));
    unsubscribeServiceEventLogs();
    await crew.stop("signal");
  };

  installSignalHandlers(stop);

  await crew.start();
  const workerPoolMembers = resolveWorkerPoolMembers(crew.config);
  const reconcileResult = await createDenPoolMemberReconciler({
    mcpClient: crew.mcpClient,
    assignedBy: "pi-crew",
    members: workerPoolMembers,
    cleanupGroups: resolveWorkerPoolCleanupGroups(crew.config),
  }).reconcile();
  if (reconcileResult.degraded.length > 0) {
    logger.warn("worker_pool.reconcile_degraded", { degraded: reconcileResult.degraded });
  }
  assignmentLoops = createCrewAssignmentLoops({
    crew,
    members: workerPoolMembers,
    logger,
    pollIntervalMs: 2_000,
  });
  assignmentLoops.forEach((loop) => {
    loop.start();
  });

  console.log("pi-crew service started");
  console.log(`assignment loops started: ${String(assignmentLoops.length)}`);

  // Local foreground health smoke
  const { host, port } = crew.gateway.healthConfig;
  const healthy = await healthSmoke(host, port);
  if (!healthy) {
    console.warn("Health smoke did not confirm ok status — gateway may still be starting");
  }

  return { crew, stop };
}

// ── Degraded mode (config load failed) ──────────────────────────

/**
 * Enter degraded mode: keep the health server alive and watch the config
 * file for changes. Returns when a valid config is loaded (either via
 * file change or admin API) or on shutdown signal.
 */
async function enterDegradedMode(
  degradedServer: DegradedHealthServer,
  configPath: string,
  result: ConfigDegradedResult,
  logger: ServiceConsoleLogger,
): Promise<{ ok: true; config: CrewConfig; configPath: string; skippedAgentErrors: Array<{ field: string; message: string }> } | { ok: false }> {
  logger.error("config.load_failed", {
    fileError: result.fileError,
    errors: result.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    configPath,
  });
  console.error("Config loading failed — service running in DEGRADED mode");
  console.error("Fix the config and save the file, or POST a corrected YAML to the admin endpoint.");
  console.error(`Errors:\n${result.errors.map((e: { field: string; message: string }) => `  - ${e.field}: ${e.message}`).join("\n")}`);

  // Set up degraded server handler for admin reload via POST
  // (file watching is already handled by the server instance)

  // Try the file-watch path (Option C from design doc)
  console.log(`Watching ${configPath} for changes...`);
  return await Promise.race([
    degradedServer.watchConfigFile(configPath).then(() => {
      // Config file changed and reloaded successfully
      const loadResult = tryLoadCrewConfigDegraded(configPath);
      if (loadResult.ok) {
        return { ok: true as const, config: loadResult.config, configPath, skippedAgentErrors: loadResult.skippedAgentErrors };
      }
      // Shouldn't happen since watch handler only resolves on success
      return { ok: false as const };
    }),
    // Also allow graceful shutdown while waiting
    new Promise<{ ok: false }>((resolve) => {
      const handler = () => {
        resolve({ ok: false });
      };
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
    }),
  ]);
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = earlyConfigPath();
  console.log(`pi-crew starting with config: ${configPath}`);

  // Step 1: Start degraded health server on the best-guess config port
  const healthConfig = extractHealthConfig(configPath);
  const degradedServer = new DegradedHealthServer(
    { host: healthConfig.host, port: healthConfig.port },
    { errors: [], configPath },
  );
  await degradedServer.start();
  console.log(`Degraded health server listening on ${healthConfig.host}:${String(healthConfig.port)}`);

  // Step 2: Try to load crew config (with per-agent isolation)
  const loadResult = tryLoadCrewConfigDegraded(configPath);

  if (!loadResult.ok) {
    // Step 3b: Config failed — enter degraded mode
    const degradedResult = loadResult.result;
    const logger = new ServiceConsoleLogger({ level: "info", json: false });
    const recovered = await enterDegradedMode(degradedServer, configPath, degradedResult, logger);

    if (!recovered.ok) {
      // Shutdown requested while in degraded mode
      await degradedServer.stop();
      console.log("pi-crew exiting (degraded mode shutdown)");
      return;
    }

    // We recovered! Fall through to start the crew with the new config.
    await degradedServer.stop();
    const { crew, stop } = await startCrew(recovered.config, configPath, recovered.skippedAgentErrors);
    stdout.write("pi-crew running (Ctrl+C to stop)\n");
    return;
  }

  // Step 3a: Config loaded — stop degraded server, start normally
  await degradedServer.stop();
  const { crew, stop } = await startCrew(loadResult.config, configPath, loadResult.skippedAgentErrors);
  stdout.write("pi-crew running (Ctrl+C to stop)\n");
}

main().catch((error: unknown) => {
  console.error("Fatal startup error:", (error as Error).message);
  exit(1);
});
