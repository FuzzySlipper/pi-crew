/**
 * Pi-service daemon entry point.
 *
 * Responsibilities:
 * - Parse and validate configuration (crash on invalid).
 * - Wire the dependency-injection container.
 * - Start the gateway (health-check server, event bus, etc.).
 * - Listen for SIGTERM (graceful shutdown) and SIGHUP (config reload).
 * - Exit cleanly on unrecoverable errors.
 *
 * @module pi-service/main
 */

import { FakeEventBus, FakeLogger, InMemoryHookRegistry } from "@pi-crew/core";
import { loadConfig } from "./config.js";
import { createServiceRegistry } from "./di.js";
import {
  ExtensionActivator,
  createServiceExtensionContext,
  createUnavailableDelegationSessionBridge,
} from "./extension-activator.js";
import { Gateway } from "./gateway.js";
import { AdminServer } from "./admin/admin-server.js";
import { RuntimeMetricsCollector, renderPrometheusMetrics } from "./diagnostics/runtime-metrics.js";
import type { DiagnosticsOverview } from "./diagnostics/types.js";
import {
  InMemoryToolPolicySessionRegistry,
  ToolPolicyExtension,
} from "./workers/tool-policy-extension.js";

// ── Signal handlers ─────────────────────────────────────────────

let gateway: Gateway | null = null;
let adminServer: AdminServer | null = null;
let extensionActivator: ExtensionActivator | null = null;
let shutdownInitiated = false;

/**
 * Graceful shutdown on SIGTERM.
 *
 * Follows the shutdown sequence: stop the health server, emit
 * `gateway.shutdown`, log, and exit.
 */
async function onSigterm(): Promise<void> {
  if (shutdownInitiated) return;
  shutdownInitiated = true;

  process.stdout.write("\n"); // newline after ^C
  console.log("Received SIGTERM — initiating graceful shutdown");

  if (adminServer !== null) {
    await adminServer.stop();
  }

  if (gateway?.isRunning) {
    await gateway.stop("SIGTERM");
  }

  if (extensionActivator !== null) {
    await extensionActivator.deactivateAll();
  }

  console.log("Shutdown complete");
  process.exit(0);
}

/**
 * Reload configuration on SIGHUP.
 *
 * In this skeleton the handler acknowledges the signal and logs it.
 * Full config hot-reload will be implemented in a later task.
 */
function onSighup(): void {
  console.log("Received SIGHUP — config reload requested (not yet implemented)");
}

// ── Bootstrap ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load and validate configuration
  console.log("Loading configuration…");

  let config;
  try {
    // In a real deployment this would read from a file or env.
    // For the skeleton, we use a minimal inline default.
    config = loadConfig({
      database: {
        path: process.env["PI_DB_PATH"] ?? "/var/lib/pi-crew/runtime.db",
        wal: true,
      },
      den: {
        coreUrl: process.env["PI_DEN_CORE_URL"] ?? "http://den-srv:3030",
        requiredAtStartup:
          process.env["PI_DEN_REQUIRED_AT_STARTUP"]?.toLowerCase() !== "false",
      },
      health: {
        port: Number(process.env["PI_HEALTH_PORT"] ?? 9236),
        host: process.env["PI_HEALTH_HOST"] ?? "127.0.0.1",
      },
      admin: {
        enabled: process.env["PI_ADMIN_ENABLED"]?.toLowerCase() === "true",
        port: Number(process.env["PI_ADMIN_PORT"] ?? 9237),
        host: process.env["PI_ADMIN_HOST"] ?? "127.0.0.1",
        bearerToken: process.env["PI_ADMIN_BEARER_TOKEN"] ?? "",
        allowLanBind: process.env["PI_ADMIN_ALLOW_LAN_BIND"]?.toLowerCase() === "true",
      },
      logging: {
        level:
          (process.env["PI_LOG_LEVEL"] as
            | "debug"
            | "info"
            | "warn"
            | "error"
            | undefined) ?? "info",
        json: false,
      },
    });
  } catch (err) {
    console.error("FATAL: Configuration error:", (err as Error).message);
    process.exit(1);
  }

  console.log("Configuration valid");

  // 2. Wire dependency injection
  const logger = new FakeLogger();
  const eventBus = new FakeEventBus();
  const hookRegistry = new InMemoryHookRegistry(logger);
  const toolPolicySessions = new InMemoryToolPolicySessionRegistry();
  const registry = createServiceRegistry({
    config,
    logger,
    eventBus,
    hookRegistry,
    toolPolicySessionRegistry: toolPolicySessions,
  });
  const extensionContext = createServiceExtensionContext({
    config: registry.config,
    logger: registry.logger,
    eventBus: registry.eventBus,
    hookRegistry: registry.hookRegistry,
    delegationSessions: createUnavailableDelegationSessionBridge(),
  });
  // DESIGN: main is the composition root and owns the concrete extension list.
  // Rationale: lower packages expose contracts; service startup alone decides order.
  extensionActivator = new ExtensionActivator({
    extensions: [new ToolPolicyExtension(registry.toolPolicySessionRegistry)],
    context: extensionContext,
  });
  await extensionActivator.activateAll();
  const startedAt = new Date().toISOString();
  const metricsCollector = new RuntimeMetricsCollector(registry.eventBus, { startedAt });

  // 3. Create and start the gateway
  gateway = new Gateway(registry.config, registry.logger, registry.eventBus);

  await gateway.start();

  if (config.admin.enabled) {
    const diagnostics = { projectOverview: () => Promise.resolve(emptyDiagnosticsOverview(startedAt)) };
    adminServer = new AdminServer({
      config: config.admin,
      diagnostics,
      metrics: {
        projectPrometheus: async () =>
          renderPrometheusMetrics(metricsCollector.snapshot(), await diagnostics.projectOverview()),
      },
    });
    await adminServer.start();
    console.log(
      `Admin diagnostics running at http://${config.admin.host}:${String(config.admin.port)}/admin/diagnostics/overview`,
    );
  }

  console.log(
    `Gateway running — health check at http://${config.health.host}:${String(config.health.port)}/health`,
  );

  // 4. Register signal handlers
  process.on("SIGTERM", () => {
    void onSigterm();
  });
  process.on("SIGINT", () => {
    void onSigterm();
  });
  process.on("SIGHUP", onSighup);
}

function emptyDiagnosticsOverview(startedAt: string): DiagnosticsOverview {
  return {
    service: {
      status: "ok",
      version: "standalone-main",
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt,
      drainMode: "inactive",
    },
    classification: {
      kind: "unknown",
      summary: "Standalone pi-service main has admin diagnostics enabled without runtime projection wiring.",
    },
    denCore: { status: "degraded", lastOkAt: null },
    denChannels: { status: "degraded", lastOkAt: null },
    mcp: { status: "degraded", lastOkAt: null },
    runtimeDb: {
      status: "failed",
      error: "Standalone main has no runtime DB health reader wired.",
    },
    counts: {
      activeSessions: 0,
      workerSessions: 0,
      conversationalSessions: 0,
      activeAssignmentsLocal: 0,
      stuckWorkers: 0,
      checkpointWaiting: 0,
    },
    sessions: [],
    recentEvents: [],
  };
}

// ── Entry ────────────────────────────────────────────────────────

void main().catch((err: unknown) => {
  console.error("FATAL: Unhandled startup error:", err);
  process.exit(1);
});
