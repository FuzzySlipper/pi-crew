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

import { FakeLogger } from "@pi-crew/core";
import { FakeEventBus } from "@pi-crew/core";
import { loadConfig } from "./config.js";
import { createServiceRegistry } from "./di.js";
import { Gateway } from "./gateway.js";

// ── Signal handlers ─────────────────────────────────────────────

let gateway: Gateway | null = null;
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

  if (gateway?.isRunning) {
    await gateway.stop("SIGTERM");
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
  const registry = createServiceRegistry({ config, logger, eventBus });

  // 3. Create and start the gateway
  gateway = new Gateway(registry.config, registry.logger, registry.eventBus);

  await gateway.start();

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

// ── Entry ────────────────────────────────────────────────────────

void main().catch((err: unknown) => {
  console.error("FATAL: Unhandled startup error:", err);
  process.exit(1);
});
