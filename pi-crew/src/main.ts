/**
 * pi-crew service entrypoint — executable main for long-lived service process.
 *
 * Loads configuration from PI_CREW_CONFIG env var, --config CLI arg,
 * or /home/agents/pi-crew/config.yaml by default,
 * bootstraps the Crew composition root, starts the gateway (including the
 * health-check HTTP server), performs a local health smoke check, then
 * blocks on signals until graceful shutdown.
 *
 * Usage:
 *   PI_CREW_CONFIG=/path/to/config.yaml node dist/main.js
 *   node dist/main.js --config /path/to/config.yaml
 *   node dist/main.js  # reads /home/agents/pi-crew/config.yaml
 *
 * @module pi-crew/main
 */

import { env, argv, exit, stdout } from "node:process";
import { FakeEventBus } from "@pi-crew/core";
import { Crew, loadCrewConfig, resolveCrewConfigPath } from "./crew.js";
import { ServiceConsoleLogger, subscribeServiceEventLogs } from "./service-logger.js";

// ── Health smoke ────────────────────────────────────────────────

interface HealthResponse {
  status: string;
  uptime?: number;
}

/**
 * Perform a local health-check smoke request against the gateway.
 *
 * Returns true if the endpoint responds with status "ok".
 * Logs warnings for non-200 responses but does not fail startup —
 * the gateway is running; this is just a smoke confirmation.
 */
async function healthSmoke(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${String(port)}/`;
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      console.warn(
        `Health smoke returned HTTP ${String(response.status)} from ${url}`,
      );
      return false;
    }
    const body = (await response.json()) as HealthResponse;
    console.log(
      `Health smoke OK: status=${body.status}, uptime=${String(body.uptime ?? "n/a")}s`,
    );
    return body.status === "ok";
  } catch (error: unknown) {
    console.warn(
      `Health smoke failed: ${url} — ${(error as Error).message}`,
    );
    return false;
  }
}

// ── Signal handling ─────────────────────────────────────────────

type ShutdownFn = () => Promise<void>;

/**
 * Install process-level signal handlers for graceful shutdown.
 *
 * Catches SIGINT (Ctrl+C) and SIGTERM (process manager stop).
 * Calls the provided `stop` function and exits cleanly.
 */
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

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configPath = resolveCrewConfigPath({ argv, env, cwd: process.cwd() });
  console.log(`pi-crew starting with config: ${configPath}`);

  const config = loadCrewConfig(configPath);
  const logger = new ServiceConsoleLogger(config.logging);
  const eventBus = new FakeEventBus();
  const unsubscribeServiceEventLogs = subscribeServiceEventLogs(
    eventBus,
    logger,
  );
  const crew = new Crew(config, logger, eventBus);

  installSignalHandlers(async () => {
    unsubscribeServiceEventLogs();
    await crew.stop("signal");
  });

  await crew.start();

  console.log("pi-crew service started");

  // Local foreground health smoke
  const { host, port } = crew.gateway.healthConfig;
  const healthy = await healthSmoke(host, port);
  if (!healthy) {
    console.warn(
      "Health smoke did not confirm ok status — gateway may still be starting",
    );
  }

  stdout.write("pi-crew running (Ctrl+C to stop)\n");
}

main().catch((error: unknown) => {
  console.error("Fatal startup error:", (error as Error).message);
  exit(1);
});
